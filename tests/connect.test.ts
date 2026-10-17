import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authConfigsList: vi.fn(),
  link: vi.fn(),
  list: vi.fn(),
  prisma: {
    integrationConfig: {
      upsert: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("../lib/composio", () => ({
  getComposioClient: () => ({
    authConfigs: { list: mocks.authConfigsList },
    connectedAccounts: { link: mocks.link, list: mocks.list },
  }),
}));
vi.mock("../lib/prisma", () => ({ prisma: mocks.prisma }));

import {
  checkToolkitConnection,
  saveIntegrationMetadata,
  startToolkitConnect,
} from "../lib/connect";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authConfigsList.mockResolvedValue({
    items: [{ id: "ac_managed", isComposioManaged: true }],
  });
  mocks.prisma.integrationConfig.upsert.mockResolvedValue({});
  mocks.prisma.integrationConfig.update.mockResolvedValue({});
});

describe("startToolkitConnect", () => {
  it("links the user via the Composio-managed auth config", async () => {
    mocks.link.mockResolvedValue({
      id: "cr_1",
      redirectUrl: "https://backend.composio.dev/api/v3/s/abc",
    });

    const result = await startToolkitConnect("user_1", "notion");

    expect(mocks.authConfigsList).toHaveBeenCalledWith({ toolkit: "notion" });
    expect(mocks.link).toHaveBeenCalledWith("user_1", "ac_managed");
    expect(result).toEqual({
      connectionRequestId: "cr_1",
      redirectUrl: "https://backend.composio.dev/api/v3/s/abc",
    });
  });

  it("prefers a Composio-managed config over a custom one", async () => {
    mocks.authConfigsList.mockResolvedValue({
      items: [
        { id: "ac_custom", isComposioManaged: false },
        { id: "ac_managed", isComposioManaged: true },
      ],
    });
    mocks.link.mockResolvedValue({
      id: "cr_2",
      redirectUrl: "https://backend.composio.dev/api/v3/s/def",
    });

    await startToolkitConnect("user_1", "slack");

    expect(mocks.link).toHaveBeenCalledWith("user_1", "ac_managed");
  });

  it("falls back to any config when no managed one exists", async () => {
    mocks.authConfigsList.mockResolvedValue({
      items: [{ id: "ac_custom", isComposioManaged: false }],
    });
    mocks.link.mockResolvedValue({
      id: "cr_3",
      redirectUrl: "https://backend.composio.dev/api/v3/s/ghi",
    });

    await startToolkitConnect("user_1", "notion");

    expect(mocks.link).toHaveBeenCalledWith("user_1", "ac_custom");
  });

  it("throws when no auth config exists for the toolkit", async () => {
    mocks.authConfigsList.mockResolvedValue({ items: [] });

    await expect(startToolkitConnect("user_1", "notion")).rejects.toThrow(
      /auth config/i
    );
    expect(mocks.link).not.toHaveBeenCalled();
  });

  it("throws when Composio returns no redirect URL", async () => {
    mocks.link.mockResolvedValue({ id: "cr_4" });
    await expect(startToolkitConnect("user_1", "slack")).rejects.toThrow(
      /redirect/i
    );
  });
});

describe("checkToolkitConnection", () => {
  it("reports not-connected when no accounts exist, without writing", async () => {
    mocks.list.mockResolvedValue({ items: [] });
    const result = await checkToolkitConnection("user_1", "notion");
    expect(result).toEqual({ connected: false });
    expect(mocks.prisma.integrationConfig.upsert).not.toHaveBeenCalled();
  });

  it("persists an active Notion account and reports connected", async () => {
    mocks.list.mockResolvedValue({
      items: [{ id: "ca_123", status: "ACTIVE", authConfigId: "ac_1" }],
    });

    const result = await checkToolkitConnection("user_1", "notion");

    expect(result).toEqual({ connected: true, connectedAccountId: "ca_123" });
    expect(mocks.list).toHaveBeenCalledWith({
      userIds: ["user_1"],
      toolkitSlugs: ["notion"],
    });
    expect(mocks.prisma.integrationConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_provider: { userId: "user_1", provider: "NOTION" } },
        create: expect.objectContaining({
          userId: "user_1",
          provider: "NOTION",
          connectedAccountId: "ca_123",
          authConfigId: "ac_1",
          isActive: true,
        }),
        update: expect.objectContaining({
          connectedAccountId: "ca_123",
          isActive: true,
        }),
      })
    );
  });

  it("maps slack accounts to the SLACK provider", async () => {
    mocks.list.mockResolvedValue({
      items: [{ id: "ca_slack_1", status: "ACTIVE" }],
    });

    await checkToolkitConnection("user_1", "slack");

    expect(mocks.prisma.integrationConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_provider: { userId: "user_1", provider: "SLACK" } },
      })
    );
  });

  it("ignores accounts that are not active yet", async () => {
    mocks.list.mockResolvedValue({
      items: [{ id: "ca_pending", status: "INITIALIZING" }],
    });
    const result = await checkToolkitConnection("user_1", "notion");
    expect(result).toEqual({ connected: false });
    expect(mocks.prisma.integrationConfig.upsert).not.toHaveBeenCalled();
  });
});

describe("saveIntegrationMetadata", () => {
  it("stores metadata on the existing integration record", async () => {
    await saveIntegrationMetadata("user_1", "NOTION", {
      notionParentPageId: "page_123",
    });

    expect(mocks.prisma.integrationConfig.update).toHaveBeenCalledWith({
      where: { userId_provider: { userId: "user_1", provider: "NOTION" } },
      data: { metadata: { notionParentPageId: "page_123" } },
    });
  });
});
