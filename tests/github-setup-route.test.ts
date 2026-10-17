import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    githubInstallation: {
      upsert: vi.fn(),
    },
    workflow: {
      count: vi.fn(),
      create: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("../lib/prisma", () => ({ prisma: mocks.prisma }));

import { GET } from "../app/api/github/setup/route";
import { signInstallState } from "../lib/installState";

function setupRequest(params: Record<string, string>): Request {
  const url = new URL("http://localhost:3000/api/github/setup");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new Request(url.toString());
}

function validState(): string {
  return signInstallState("user_1");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.user.findUnique.mockResolvedValue({ id: "user_1" });
  mocks.prisma.githubInstallation.upsert.mockResolvedValue({});
  mocks.prisma.workflow.count.mockResolvedValue(0);
  mocks.prisma.workflow.create.mockResolvedValue({ id: "wf_default" });
});

describe("GET /api/github/setup", () => {
  it("links the installation to the state's user and redirects to onboarding", async () => {
    const res = await GET(
      setupRequest({
        installation_id: "12345",
        setup_action: "install",
        state: validState(),
      })
    );

    expect(mocks.prisma.githubInstallation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { installationId: 12345 },
        create: expect.objectContaining({
          installationId: 12345,
          userId: "user_1",
        }),
        update: expect.objectContaining({ userId: "user_1", suspendedAt: null }),
      })
    );

    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toContain("/onboarding");
  });

  it("creates a default wildcard workflow for first-time users", async () => {
    mocks.prisma.workflow.count.mockResolvedValue(0);
    await GET(
      setupRequest({
        installation_id: "12345",
        setup_action: "install",
        state: validState(),
      })
    );

    expect(mocks.prisma.workflow.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user_1",
          status: "ACTIVE",
          triggerType: "GITHUB_ISSUE_OPENED",
          triggerConfig: { repositories: ["*"] },
        }),
      })
    );
  });

  it("does not create a second workflow when the user already has one", async () => {
    mocks.prisma.workflow.count.mockResolvedValue(2);
    await GET(
      setupRequest({
        installation_id: "12345",
        setup_action: "update",
        state: validState(),
      })
    );

    expect(mocks.prisma.workflow.create).not.toHaveBeenCalled();
    expect(mocks.prisma.githubInstallation.upsert).toHaveBeenCalled();
  });

  it("rejects an invalid state with a sign-in redirect and no writes", async () => {
    const res = await GET(
      setupRequest({
        installation_id: "12345",
        setup_action: "install",
        state: "forged-state",
      })
    );

    expect(res.headers.get("location")).toContain("/signin");
    expect(mocks.prisma.githubInstallation.upsert).not.toHaveBeenCalled();
    expect(mocks.prisma.workflow.create).not.toHaveBeenCalled();
  });

  it("rejects a missing installation id", async () => {
    const res = await GET(setupRequest({ state: validState() }));
    expect(res.headers.get("location")).toContain("/signin");
    expect(mocks.prisma.githubInstallation.upsert).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric installation id", async () => {
    const res = await GET(
      setupRequest({ installation_id: "abc", state: validState() })
    );
    expect(res.headers.get("location")).toContain("/signin");
    expect(mocks.prisma.githubInstallation.upsert).not.toHaveBeenCalled();
  });

  it("rejects a state that points at a missing user", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(null);
    const res = await GET(
      setupRequest({ installation_id: "12345", state: validState() })
    );
    expect(res.headers.get("location")).toContain("/signin");
    expect(mocks.prisma.githubInstallation.upsert).not.toHaveBeenCalled();
  });
});
