import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock("@composio/core", () => ({
  Composio: class {
    tools = { execute: mocks.execute };
  },
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    integrationConfig: { findUnique: mocks.findUnique },
  },
}));

import { sendSlackMessage } from "../lib/composio";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MOCK_INTEGRATIONS = "false";
  process.env.COMPOSIO_API_KEY = "ak_test_key";
  process.env.COMPOSIO_USER_ID = "legacy-shared-entity";
  mocks.findUnique.mockResolvedValue({
    connectedAccountId: "ca_1",
    isActive: true,
    metadata: {},
  });
  mocks.execute.mockResolvedValue({
    successful: true,
    data: { ts: "1700000000.000100" },
  });
});

describe("composio executeTool user scoping", () => {
  it("executes tools under the requesting user, ignoring COMPOSIO_USER_ID", async () => {
    const result = await sendSlackMessage({
      userId: "user_42",
      channel: "#general",
      text: "hello",
    });

    expect(result.channel).toBe("#general");
    expect(mocks.execute).toHaveBeenCalledWith(
      "SLACK_SEND_MESSAGE",
      expect.objectContaining({
        userId: "user_42",
        connectedAccountId: "ca_1",
      })
    );
  });

  it("looks up the integration for the same user", async () => {
    await sendSlackMessage({
      userId: "user_42",
      channel: "#general",
      text: "hello",
    });

    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { userId_provider: { userId: "user_42", provider: "SLACK" } },
    });
  });
});
