import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isGlobalCapReached: vi.fn(async () => false),
  prisma: {
    workflowRun: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    executionLog: {
      create: vi.fn(),
    },
  },
  analyzeGithubIssue: vi.fn(),
  createNotionPage: vi.fn(),
  sendSlackMessage: vi.fn(),
  getIntegrationContext: vi.fn(),
  resolveSlackChannel: vi.fn(() => "#general"),
}));

vi.mock("@trigger.dev/sdk", () => ({
  task: (config: unknown) => config,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("../lib/limits", () => ({
  isGlobalCapReached: mocks.isGlobalCapReached,
}));
vi.mock("../lib/composio", () => ({
  createNotionPage: mocks.createNotionPage,
  sendSlackMessage: mocks.sendSlackMessage,
  getIntegrationContext: mocks.getIntegrationContext,
  resolveSlackChannel: mocks.resolveSlackChannel,
}));
vi.mock("../mastra/agents/summarizer", () => ({
  analyzeGithubIssue: mocks.analyzeGithubIssue,
}));

import { processGithubIssue } from "../trigger/workflowTask";
import type { WorkflowTaskPayload } from "../lib/types";

const payload: WorkflowTaskPayload = {
  runId: "00000000-0000-4000-8000-000000000001",
  workflowId: "wf_1",
  userId: "user_1",
  tenantEmail: "user@example.com",
  repository: "acme/app",
  issueNumber: 42,
  issueId: 9001,
  issueTitle: "Crash on save",
  issueBody: "It crashes.",
  issueUrl: "https://github.com/acme/app/issues/42",
  reporterLogin: "alice",
};

function makeContext(attempt = 1) {
  return { ctx: { attempt: { number: attempt } } };
}

type TaskShape = {
  run: (
    payload: WorkflowTaskPayload,
    context: ReturnType<typeof makeContext>
  ) => Promise<unknown>;
};

const task = processGithubIssue as unknown as TaskShape;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isGlobalCapReached.mockResolvedValue(false);
  mocks.prisma.workflowRun.findUnique.mockResolvedValue({
    id: payload.runId,
    status: "PENDING",
    workflow: { status: "ACTIVE" },
    user: { status: "ACTIVE" },
  });
  mocks.prisma.workflowRun.update.mockResolvedValue({});
  mocks.prisma.executionLog.create.mockResolvedValue({});
  mocks.analyzeGithubIssue.mockResolvedValue({
    title: "Checkout crash",
    severity: "medium",
    summary: "A summary.",
  });
  mocks.createNotionPage.mockResolvedValue({ pageId: "page_1", url: "https://notion.so/page_1" });
  mocks.sendSlackMessage.mockResolvedValue({ channel: "#general", threadTs: "1.2" });
  mocks.getIntegrationContext.mockResolvedValue({
    connectedAccountId: "ca_1",
    metadata: {},
  });
});

describe("processGithubIssue guardrails", () => {
  it("marks the run SKIPPED when the global daily cap is reached", async () => {
    mocks.isGlobalCapReached.mockResolvedValue(true);

    const result = await task.run(payload, makeContext());

    expect(result).toMatchObject({ skipped: true });
    expect(mocks.prisma.workflowRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: payload.runId },
        data: expect.objectContaining({
          status: "SKIPPED",
          error: expect.stringContaining("global"),
        }),
      })
    );
    expect(mocks.analyzeGithubIssue).not.toHaveBeenCalled();
    expect(mocks.createNotionPage).not.toHaveBeenCalled();
    expect(mocks.sendSlackMessage).not.toHaveBeenCalled();
  });

  it("marks the run SKIPPED when the workflow was paused after enqueue", async () => {
    mocks.prisma.workflowRun.findUnique.mockResolvedValue({
      id: payload.runId,
      status: "PENDING",
      workflow: { status: "PAUSED" },
      user: { status: "ACTIVE" },
    });

    const result = await task.run(payload, makeContext());

    expect(result).toMatchObject({ skipped: true });
    expect(mocks.prisma.workflowRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SKIPPED",
          error: expect.stringContaining("paused"),
        }),
      })
    );
    expect(mocks.analyzeGithubIssue).not.toHaveBeenCalled();
  });

  it("marks the run SKIPPED when the user is suspended", async () => {
    mocks.prisma.workflowRun.findUnique.mockResolvedValue({
      id: payload.runId,
      status: "PENDING",
      workflow: { status: "ACTIVE" },
      user: { status: "SUSPENDED" },
    });

    const result = await task.run(payload, makeContext());

    expect(result).toMatchObject({ skipped: true });
    expect(mocks.analyzeGithubIssue).not.toHaveBeenCalled();
  });

  it("still processes normally when no guardrail triggers", async () => {
    const result = (await task.run(payload, makeContext())) as {
      executionPath: string;
    };

    expect(result.executionPath).toBe("notion-first");
    expect(mocks.analyzeGithubIssue).toHaveBeenCalledTimes(1);
    expect(mocks.createNotionPage).toHaveBeenCalledTimes(1);
    expect(mocks.sendSlackMessage).toHaveBeenCalledTimes(1);
    const updates = mocks.prisma.workflowRun.update.mock.calls.map(
      (call) => (call[0] as { data?: { status?: string } }).data?.status
    );
    expect(updates).toContain("RUNNING");
    expect(updates).toContain("SUCCEEDED");
  });
});
