import type { IntegrationProvider, Prisma } from "@prisma/client";
import { getComposioClient } from "./composio";
import { prisma } from "./prisma";

export type ConnectableToolkit = "notion" | "slack";

type ThirdPartyProvider = Extract<IntegrationProvider, "NOTION" | "SLACK">;

const PROVIDER_BY_TOOLKIT: Record<ConnectableToolkit, ThirdPartyProvider> = {
  notion: "NOTION",
  slack: "SLACK",
};

export interface StartConnectResult {
  connectionRequestId: string;
  redirectUrl: string;
}

interface ConnectionRequestLike {
  id?: unknown;
  redirectUrl?: unknown;
}

export async function startToolkitConnect(
  userId: string,
  toolkit: ConnectableToolkit
): Promise<StartConnectResult> {
  const composio = getComposioClient();
  const authorize = composio.toolkits.authorize as unknown as (
    userId: string,
    toolkitSlug: string
  ) => Promise<ConnectionRequestLike>;
  const request = await authorize(userId, toolkit);

  const redirectUrl =
    typeof request?.redirectUrl === "string" && request.redirectUrl.length > 0
      ? request.redirectUrl
      : null;
  if (!redirectUrl) {
    throw new Error(`Composio did not return a redirect URL for ${toolkit}`);
  }

  return {
    connectionRequestId: typeof request.id === "string" ? request.id : "",
    redirectUrl,
  };
}

export interface ConnectStatus {
  connected: boolean;
  connectedAccountId?: string;
}

interface ConnectedAccountLike {
  id?: unknown;
  status?: unknown;
  authConfigId?: unknown;
}

export async function checkToolkitConnection(
  userId: string,
  toolkit: ConnectableToolkit
): Promise<ConnectStatus> {
  const composio = getComposioClient();
  const list = composio.connectedAccounts.list as unknown as (
    query: unknown
  ) => Promise<{ items?: ConnectedAccountLike[] }>;
  const response = await list({
    userIds: [userId],
    toolkitSlugs: [toolkit],
  });

  const items = Array.isArray(response?.items) ? response.items : [];
  const active = items.find(
    (item) =>
      typeof item?.status === "string" &&
      item.status.toUpperCase() === "ACTIVE" &&
      typeof item.id === "string"
  );

  if (!active || typeof active.id !== "string") {
    return { connected: false };
  }

  const provider = PROVIDER_BY_TOOLKIT[toolkit];
  const authConfigId =
    typeof active.authConfigId === "string" ? active.authConfigId : null;

  await prisma.integrationConfig.upsert({
    where: { userId_provider: { userId, provider } },
    create: {
      userId,
      provider,
      connectedAccountId: active.id,
      authConfigId,
      isActive: true,
    },
    update: {
      connectedAccountId: active.id,
      authConfigId,
      isActive: true,
    },
  });

  return { connected: true, connectedAccountId: active.id };
}

export async function saveIntegrationMetadata(
  userId: string,
  provider: ThirdPartyProvider,
  metadata: Record<string, unknown>
): Promise<void> {
  await prisma.integrationConfig.update({
    where: { userId_provider: { userId, provider } },
    data: { metadata: metadata as Prisma.InputJsonValue },
  });
}
