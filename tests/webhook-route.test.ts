import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";

const mocks = vi.hoisted(() => ({
  claimOnce: vi.fn(async (_key: string, _ttlSeconds: number) => true),
  prisma: {
    githubInstallation: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    workflow: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    workflowRun: {
      create: vi.fn(),
      update: vi.fn(),
    },
    account: {
      findFirst: vi.fn(),
    },
  },
  consumeRunQuota: vi.fn(
    async (_userId: string): Promise<{ allowed: boolean; reason?: string }> => ({
      allowed: true,
    })
  ),
  tasksTrigger: vi.fn(
    async (_taskId: string, _payload: unknown, _options?: unknown) => ({
      id: "trigger_run_1",
    })
  ),
  idempotencyCreate: vi.fn(async (_parts: string[]) => "idem-key"),
  sendSlackMessage: vi.fn(async (_params: unknown) => ({ channel: "#alerts" })),
  getIntegrationContext: vi.fn(async (_userId: string, _provider: string) => ({
    connectedAccountId: "ca_mock",
    metadata: {},
  })),
  resolveSlackChannel: vi.fn((_metadata: unknown, _purpose: string) => "#alerts"),
}));

vi.mock("../lib/redis", () => ({ claimOnce: mocks.claimOnce, redis: {} }));
vi.mock("../lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("../lib/limits", () => ({ consumeRunQuota: mocks.consumeRunQuota }));
vi.mock("../lib/composio", () => ({
  sendSlackMessage: mocks.sendSlackMessage,
  getIntegrationContext: mocks.getIntegrationContext,
  resolveSlackChannel: mocks.resolveSlackChannel,
}));
vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: mocks.tasksTrigger },
  idempotencyKeys: { create: mocks.idempotencyCreate },
}));

import { POST } from "../app/api/webhooks/github/route";
import { PROCESS_GITHUB_ISSUE_TASK_ID } from "../lib/types";

function signedRequest(opts: {
  event: string;
  delivery?: string;
  payload: unknown;
}): Request {
  const body = JSON.stringify(opts.payload);
  const signature =
    "sha256=" +
    createHmac("sha256", "test-webhook-secret").update(body, "utf8").digest("hex");
  return new Request("http://localhost:3000/api/webhooks/github", {
    method: "POST",
    headers: {
      "x-hub-signature-256": signature,
      "x-github-event": opts.event,
      "x-github-delivery": opts.delivery ?? `d-${Math.random().toString(36).slice(2)}`,
      "content-type": "application/json",
    },
    body,
  });
}

function issuePayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "opened",
    issue: {
      id: 9001,
      number: 42,
      title: "Crash on save",
      body: "It crashes on save.",
      html_url: "https://github.com/acme/app/issues/42",
      state: "open",
      labels: [],
      user: { login: "alice" },
    },
    repository: {
      id: 55,
      full_name: "acme/app",
      html_url: "https://github.com/acme/app",
      private: false,
    },
    sender: { login: "alice" },
    installation: { id: 12345 },
    ...overrides,
  };
}

function installationPayload(action: string, installationOverrides: Record<string, unknown> = {}) {
  return {
    action,
    installation: {
      id: 12345,
      account: { id: 777, login: "alice", type: "User" },
      suspended_at: null,
      ...installationOverrides,
    },
    sender: { login: "alice" },
  };
}

function installationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "inst_row_1",
    installationId: 12345,
    userId: "user_1",
    accountLogin: "alice",
    accountType: "User",
    suspendedAt: null,
    user: { email: "alice@example.com", status: "ACTIVE" },
    ...overrides,
  };
}

function matchingWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    id: "wf_1",
    userId: "user_1",
    triggerConfig: { repositories: ["*"] },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.claimOnce.mockResolvedValue(true);
  mocks.consumeRunQuota.mockResolvedValue({ allowed: true });
  mocks.prisma.githubInstallation.findUnique.mockResolvedValue(installationRow());
  mocks.prisma.githubInstallation.upsert.mockResolvedValue({});
  mocks.prisma.githubInstallation.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.githubInstallation.deleteMany.mockResolvedValue({ count: 1 });
  mocks.prisma.workflow.findMany.mockResolvedValue([matchingWorkflow()]);
  mocks.prisma.workflowRun.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({ id: "run_1", ...data })
  );
  mocks.prisma.workflowRun.update.mockResolvedValue({});
  mocks.prisma.account.findFirst.mockResolvedValue(null);
});

describe("POST /api/webhooks/github — issue events", () => {
  it("enqueues a run for the installation owner and returns 202", async () => {
    const res = await POST(
      signedRequest({ event: "issues", payload: issuePayload() })
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe("accepted");
    expect(body.triggeredRuns).toBe(1);
    expect(mocks.tasksTrigger).toHaveBeenCalledTimes(1);
    expect(mocks.tasksTrigger.mock.calls[0][0]).toBe(PROCESS_GITHUB_ISSUE_TASK_ID);
    expect(mocks.prisma.workflowRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: "user_1", status: "PENDING" }),
      })
    );
  });

  it("routes only to workflows owned by the installation's user", async () => {
    await POST(signedRequest({ event: "issues", payload: issuePayload() }));
    expect(mocks.prisma.workflow.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "user_1" }),
      })
    );
  });

  it("ignores duplicate deliveries", async () => {
    mocks.claimOnce.mockResolvedValueOnce(false);
    const res = await POST(
      signedRequest({ event: "issues", payload: issuePayload() })
    );
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("duplicate_delivery_ignored");
    expect(mocks.tasksTrigger).not.toHaveBeenCalled();
  });

  it("rejects invalid signatures with 401", async () => {
    const body = JSON.stringify(issuePayload());
    const req = new Request("http://localhost:3000/api/webhooks/github", {
      method: "POST",
      headers: {
        "x-hub-signature-256": "sha256=" + "0".repeat(64),
        "x-github-event": "issues",
        "x-github-delivery": "d-bad-sig",
      },
      body,
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(mocks.tasksTrigger).not.toHaveBeenCalled();
  });

  it("ignores issues whose installation is unknown", async () => {
    mocks.prisma.githubInstallation.findUnique.mockResolvedValue(null);
    const res = await POST(
      signedRequest({ event: "issues", payload: issuePayload() })
    );
    expect(res.status).toBe(202);
    expect((await res.json()).reason).toBe("unknown_installation");
    expect(mocks.tasksTrigger).not.toHaveBeenCalled();
    expect(mocks.prisma.workflowRun.create).not.toHaveBeenCalled();
  });

  it("ignores issues when the payload carries no installation", async () => {
    const payload = issuePayload();
    delete (payload as Record<string, unknown>).installation;
    const res = await POST(signedRequest({ event: "issues", payload }));
    expect(res.status).toBe(202);
    expect((await res.json()).reason).toBe("no_installation");
    expect(mocks.tasksTrigger).not.toHaveBeenCalled();
  });

  it("ignores issues for suspended installations", async () => {
    mocks.prisma.githubInstallation.findUnique.mockResolvedValue(
      installationRow({ suspendedAt: new Date("2026-10-01T00:00:00Z") })
    );
    const res = await POST(
      signedRequest({ event: "issues", payload: issuePayload() })
    );
    expect(res.status).toBe(202);
    expect((await res.json()).reason).toBe("installation_suspended");
    expect(mocks.tasksTrigger).not.toHaveBeenCalled();
  });

  it("ignores issues for suspended users", async () => {
    mocks.prisma.githubInstallation.findUnique.mockResolvedValue(
      installationRow({ user: { email: "alice@example.com", status: "SUSPENDED" } })
    );
    const res = await POST(
      signedRequest({ event: "issues", payload: issuePayload() })
    );
    expect(res.status).toBe(202);
    expect((await res.json()).reason).toBe("user_suspended");
    expect(mocks.tasksTrigger).not.toHaveBeenCalled();
  });

  it("returns no_matching_workflows when trigger config does not match", async () => {
    mocks.prisma.workflow.findMany.mockResolvedValue([
      matchingWorkflow({ triggerConfig: { repositories: ["other/repo"] } }),
    ]);
    const res = await POST(
      signedRequest({ event: "issues", payload: issuePayload() })
    );
    expect(res.status).toBe(202);
    expect((await res.json()).reason).toBe("no_matching_workflows");
    expect(mocks.tasksTrigger).not.toHaveBeenCalled();
  });

  it("ignores unsupported issue actions", async () => {
    const res = await POST(
      signedRequest({ event: "issues", payload: issuePayload({ action: "closed" }) })
    );
    expect(res.status).toBe(202);
    expect((await res.json()).status).toBe("ignored");
    expect(mocks.tasksTrigger).not.toHaveBeenCalled();
  });

  it("records a SKIPPED run when the user is over quota", async () => {
    mocks.consumeRunQuota.mockResolvedValue({
      allowed: false,
      reason: "user_daily_cap",
    });
    const res = await POST(
      signedRequest({ event: "issues", payload: issuePayload() })
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.triggeredRuns).toBe(0);
    expect(body.skippedRuns).toBe(1);
    expect(mocks.tasksTrigger).not.toHaveBeenCalled();
    expect(mocks.prisma.workflowRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SKIPPED",
          error: expect.stringContaining("user_daily_cap"),
        }),
      })
    );
  });

  it("alerts the owner once per day when the cap is first hit", async () => {
    mocks.consumeRunQuota.mockResolvedValue({
      allowed: false,
      reason: "user_daily_cap",
    });
    await POST(signedRequest({ event: "issues", payload: issuePayload() }));
    expect(mocks.claimOnce).toHaveBeenCalledWith(
      expect.stringContaining("quota-alert:user_1"),
      expect.any(Number)
    );
    expect(mocks.sendSlackMessage).toHaveBeenCalledTimes(1);
  });

  it("does not re-alert when the daily alert was already sent", async () => {
    mocks.consumeRunQuota.mockResolvedValue({
      allowed: false,
      reason: "user_daily_cap",
    });
    mocks.claimOnce.mockImplementation(async (key: string) => {
      return !String(key).startsWith("quota-alert:");
    });
    await POST(signedRequest({ event: "issues", payload: issuePayload() }));
    expect(mocks.sendSlackMessage).not.toHaveBeenCalled();
  });

  it("still records the SKIPPED run when the alert itself fails", async () => {
    mocks.consumeRunQuota.mockResolvedValue({
      allowed: false,
      reason: "user_daily_cap",
    });
    mocks.sendSlackMessage.mockRejectedValueOnce(new Error("composio down"));
    const res = await POST(
      signedRequest({ event: "issues", payload: issuePayload() })
    );
    expect(res.status).toBe(202);
    expect(mocks.prisma.workflowRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SKIPPED" }),
      })
    );
  });
});

describe("POST /api/webhooks/github — installation events", () => {
  it("creates an installation row when the account maps to a user", async () => {
    mocks.prisma.account.findFirst.mockResolvedValue({ userId: "user_9" });
    const res = await POST(
      signedRequest({ event: "installation", payload: installationPayload("created") })
    );
    expect(res.status).toBe(202);
    expect(mocks.prisma.githubInstallation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { installationId: 12345 },
        create: expect.objectContaining({
          installationId: 12345,
          userId: "user_9",
          accountLogin: "alice",
          accountType: "User",
        }),
      })
    );
  });

  it("enriches an existing row when the account cannot be matched", async () => {
    mocks.prisma.account.findFirst.mockResolvedValue(null);
    mocks.prisma.githubInstallation.updateMany.mockResolvedValue({ count: 1 });
    const res = await POST(
      signedRequest({ event: "installation", payload: installationPayload("created") })
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.reason).toBe("installation_updated");
    expect(mocks.prisma.githubInstallation.upsert).not.toHaveBeenCalled();
    expect(mocks.prisma.githubInstallation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { installationId: 12345 },
        data: expect.objectContaining({ accountLogin: "alice", accountType: "User" }),
      })
    );
  });

  it("defers attribution when neither path resolves", async () => {
    mocks.prisma.account.findFirst.mockResolvedValue(null);
    mocks.prisma.githubInstallation.updateMany.mockResolvedValue({ count: 0 });
    const res = await POST(
      signedRequest({ event: "installation", payload: installationPayload("created") })
    );
    expect(res.status).toBe(202);
    expect((await res.json()).reason).toBe("pending_setup");
  });

  it("removes the installation row on deletion", async () => {
    const res = await POST(
      signedRequest({ event: "installation", payload: installationPayload("deleted") })
    );
    expect(res.status).toBe(202);
    expect(mocks.prisma.githubInstallation.deleteMany).toHaveBeenCalledWith({
      where: { installationId: 12345 },
    });
  });

  it("marks suspended installations", async () => {
    const res = await POST(
      signedRequest({ event: "installation", payload: installationPayload("suspend") })
    );
    expect(res.status).toBe(202);
    expect(mocks.prisma.githubInstallation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { installationId: 12345 },
        data: expect.objectContaining({ suspendedAt: expect.any(Date) }),
      })
    );
  });

  it("clears suspension on unsuspend", async () => {
    const res = await POST(
      signedRequest({ event: "installation", payload: installationPayload("unsuspend") })
    );
    expect(res.status).toBe(202);
    expect(mocks.prisma.githubInstallation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { installationId: 12345 },
        data: expect.objectContaining({ suspendedAt: null }),
      })
    );
  });

  it("ignores other installation actions", async () => {
    const res = await POST(
      signedRequest({
        event: "installation",
        payload: installationPayload("new_permissions_accepted"),
      })
    );
    expect(res.status).toBe(202);
    expect((await res.json()).status).toBe("ignored");
  });
});
