import { Composio } from "@composio/core";
import type { IntegrationProvider } from "@prisma/client";
import { z } from "zod";
import { prisma } from "./prisma";

let composioClient: Composio | null = null;

export function getComposioClient(): Composio {
  if (composioClient) {
    return composioClient;
  }

  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    throw new Error("COMPOSIO_API_KEY is not configured");
  }

  composioClient = new Composio({
    apiKey,
    toolkitVersions: {
      github: "latest",
      notion: "latest",
      slack: "latest",
    },
  });

  return composioClient;
}

const integrationMetadataSchema = z.object({
  notionParentPageId: z.string().min(1).optional(),
  slackChannel: z.string().min(1).optional(),
  slackAlertChannel: z.string().min(1).optional(),
});

export interface IntegrationContext {
  connectedAccountId: string;
  metadata: z.infer<typeof integrationMetadataSchema>;
}

function isMockIntegrationsEnabled(): boolean {
  return process.env.MOCK_INTEGRATIONS === "true";
}

export async function getIntegrationContext(
  userId: string,
  provider: Extract<IntegrationProvider, "NOTION" | "SLACK">
): Promise<IntegrationContext> {
  if (isMockIntegrationsEnabled()) {
    console.log(`[MOCK] Skipping ${provider} connected-account lookup (MOCK_INTEGRATIONS=true)`);
    return { connectedAccountId: "mock-connected-account", metadata: {} };
  }

  const config = await prisma.integrationConfig.findUnique({
    where: { userId_provider: { userId, provider } },
  });

  if (!config || !config.isActive) {
    throw new Error(`No active ${provider} integration configured for user ${userId}`);
  }

  return {
    connectedAccountId: config.connectedAccountId,
    metadata: integrationMetadataSchema.parse(config.metadata ?? {}),
  };
}

interface ComposioExecuteResponse<TData> {
  successful?: boolean;
  data?: TData;
  error?: unknown;
}

async function executeTool<TData>(
  slug: string,
  params: {
    userId: string;
    connectedAccountId: string;
    args: Record<string, unknown>;
  }
): Promise<TData> {
  const composio = getComposioClient();

  const response = (await composio.tools.execute(slug, {
    userId: params.userId,
    connectedAccountId: params.connectedAccountId,
    arguments: params.args,
    dangerouslySkipVersionCheck: true,
  })) as ComposioExecuteResponse<TData>;

  if (response.successful === false) {
    const reason =
      typeof response.error === "string"
        ? response.error
        : JSON.stringify(response.error ?? "unknown error");
    throw new Error(`Composio tool ${slug} execution failed: ${reason}`);
  }

  if (response.data === undefined || response.data === null) {
    throw new Error(`Composio tool ${slug} returned an empty payload`);
  }

  return response.data;
}

export interface NotionPageResult {
  pageId: string;
  url: string;
}

export async function createNotionPage(params: {
  userId: string;
  title: string;
  markdownContent: string;
}): Promise<NotionPageResult> {
  if (isMockIntegrationsEnabled()) {
    const pageId = `mock-notion-page-${Date.now()}`;
    console.log(`[MOCK] Would create Notion page: "${params.title}" (${params.markdownContent.length} chars)`);
    return { pageId, url: `https://www.notion.so/${pageId.replace(/-/g, "")}` };
  }

  const { connectedAccountId, metadata } = await getIntegrationContext(
    params.userId,
    "NOTION"
  );

  const parentPageId = metadata.notionParentPageId ?? process.env.NOTION_PARENT_PAGE_ID;
  if (!parentPageId) {
    throw new Error(
      `Missing Notion parent page for user ${params.userId}: set integration metadata.notionParentPageId or NOTION_PARENT_PAGE_ID`
    );
  }

  const data = await executeTool<Record<string, unknown>>("NOTION_CREATE_NOTION_PAGE", {
    userId: params.userId,
    connectedAccountId,
    args: {
      parent_id: parentPageId,
      title: params.title,
      markdown: params.markdownContent,
    },
  });

  return {
    pageId: typeof data.id === "string" ? data.id : "",
    url: typeof data.url === "string" ? data.url : "",
  };
}

export interface SlackMessageResult {
  channel: string;
  threadTs?: string;
}

export type SlackChannelPurpose = "notifications" | "alerts";

export function resolveSlackChannel(
  metadata: IntegrationContext["metadata"],
  purpose: SlackChannelPurpose
): string {
  if (purpose === "alerts") {
    return (
      metadata.slackAlertChannel ??
      process.env.SLACK_ALERT_CHANNEL ??
      "#incident-alerts"
    );
  }
  return metadata.slackChannel ?? process.env.SLACK_DEFAULT_CHANNEL ?? "#general";
}

export async function sendSlackMessage(params: {
  userId: string;
  channel: string;
  text: string;
}): Promise<SlackMessageResult> {
  if (isMockIntegrationsEnabled()) {
    console.log(`[MOCK] Would send Slack message to ${params.channel}: ${params.text.split("\n")[0]}`);
    return { channel: params.channel, threadTs: `${Date.now()}.000000` };
  }

  const { connectedAccountId } = await getIntegrationContext(params.userId, "SLACK");

  const data = await executeTool<Record<string, unknown>>("SLACK_SEND_MESSAGE", {
    userId: params.userId,
    connectedAccountId,
    args: {
      channel: params.channel,
      markdown_text: params.text,
    },
  });

  return {
    channel: params.channel,
    threadTs: typeof data.ts === "string" ? data.ts : undefined,
  };
}

export async function listUserIntegrations(userId: string) {
  return prisma.integrationConfig.findMany({
    where: { userId, isActive: true },
    select: {
      provider: true,
      connectedAccountId: true,
      authConfigId: true,
      updatedAt: true,
    },
  });
}
