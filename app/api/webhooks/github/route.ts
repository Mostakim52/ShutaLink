import { createHmac, timingSafeEqual } from "node:crypto";
import type { RunStatus, TriggerType, WorkflowStatus } from "@prisma/client";
import { idempotencyKeys, tasks } from "@trigger.dev/sdk";
import { NextResponse } from "next/server";
import {
  getIntegrationContext,
  resolveSlackChannel,
  sendSlackMessage,
} from "../../../../lib/composio";
import { consumeRunQuota, type QuotaRejectionReason } from "../../../../lib/limits";
import { prisma } from "../../../../lib/prisma";
import { claimOnce } from "../../../../lib/redis";
import {
  PROCESS_GITHUB_ISSUE_TASK_ID,
  githubInstallationWebhookSchema,
  githubIssueWebhookSchema,
  workflowTriggerConfigSchema,
  type GithubIssueWebhookEvent,
  type WorkflowTaskPayload,
} from "../../../../lib/types";

export const dynamic = "force-dynamic";

const WEBHOOK_DEDUPE_TTL_SECONDS = 60 * 60 * 24;
const QUOTA_ALERT_TTL_SECONDS = 60 * 60 * 24;

class WebhookValidationError extends Error {}

function assertValidSignature(rawBody: string, signatureHeader: string | null): void {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    throw new WebhookValidationError("Missing or malformed x-hub-signature-256 header");
  }

  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    throw new WebhookValidationError("GITHUB_WEBHOOK_SECRET is not configured");
  }

  const digest = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  const provided = Buffer.from(signatureHeader.slice("sha256=".length), "hex");

  if (provided.length !== digest.length || !timingSafeEqual(digest, provided)) {
    throw new WebhookValidationError("Webhook signature verification failed");
  }
}

function ignored(deliveryId: string, reason: string): Response {
  return NextResponse.json({ status: "ignored", reason, deliveryId }, { status: 202 });
}

function matchesTriggerConfig(
  rawConfig: unknown,
  event: GithubIssueWebhookEvent
): boolean {
  const parsed = workflowTriggerConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    return false;
  }

  const config = parsed.data;
  const repoFullName = event.repository.full_name;
  const repositoryMatch =
    config.repositories.includes("*") || config.repositories.includes(repoFullName);

  if (!repositoryMatch) {
    return false;
  }

  if (config.labels && config.labels.length > 0) {
    const issueLabels = (event.issue.labels ?? [])
      .map((label) => label.name)
      .filter((name): name is string => name !== null);
    return issueLabels.some((label) => config.labels?.includes(label));
  }

  return true;
}

function buildTaskPayload(
  workflowId: string,
  userId: string,
  tenantEmail: string,
  event: GithubIssueWebhookEvent
): WorkflowTaskPayload {
  return {
    runId: "",
    workflowId,
    userId,
    tenantEmail,
    repository: event.repository.full_name,
    issueNumber: event.issue.number,
    issueId: event.issue.id,
    issueTitle: event.issue.title,
    issueBody: event.issue.body,
    issueUrl: event.issue.html_url,
    reporterLogin: event.sender?.login ?? event.issue.user?.login,
  };
}

interface EnqueueOutcome {
  workflowId: string;
  runId: string;
  triggerRunId: string | null;
}

interface SkipOutcome {
  workflowId: string;
  runId: string;
  reason: QuotaRejectionReason;
}

async function enqueueWorkflowRun(
  workflow: { id: string; userId: string },
  userEmail: string,
  event: GithubIssueWebhookEvent,
  deliveryId: string
): Promise<EnqueueOutcome> {
  const run = await prisma.workflowRun.create({
    data: {
      workflowId: workflow.id,
      userId: workflow.userId,
      status: "PENDING",
      triggerPayload: {
        deliveryId,
        repository: event.repository.full_name,
        issueNumber: event.issue.number,
        action: event.action,
      },
    },
  });

  const payload: WorkflowTaskPayload = {
    ...buildTaskPayload(workflow.id, workflow.userId, userEmail, event),
    runId: run.id,
  };

  const idempotencyKey = await idempotencyKeys.create([
    "github-issue",
    String(event.issue.id),
    workflow.id,
  ]);

  const handle = await tasks.trigger(PROCESS_GITHUB_ISSUE_TASK_ID, payload, {
    idempotencyKey,
  });

  if (handle.id) {
    await prisma.workflowRun.update({
      where: { id: run.id },
      data: { triggerRunId: handle.id },
    });
  }

  return { workflowId: workflow.id, runId: run.id, triggerRunId: handle.id };
}

function utcDayKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

async function notifyQuotaReached(userId: string): Promise<void> {
  const firstToday = await claimOnce(
    `quota-alert:${userId}:${utcDayKey()}`,
    QUOTA_ALERT_TTL_SECONDS
  );
  if (!firstToday) {
    return;
  }

  try {
    const context = await getIntegrationContext(userId, "SLACK");
    const channel = resolveSlackChannel(context.metadata, "alerts");
    await sendSlackMessage({
      userId,
      channel,
      text: [
        ":hourglass: *ShutaLink paused triage for today.*",
        "",
        "This workspace hit the daily run cap that protects the free plan.",
        "Newly opened issues stay in GitHub untouched and triage resumes at 00:00 UTC.",
      ].join("\n"),
    });
  } catch (error) {
    console.warn(
      "[webhook] quota alert failed:",
      error instanceof Error ? error.message : error
    );
  }
}

async function handleIssueEvent(payload: unknown, deliveryId: string): Promise<Response> {
  const event = githubIssueWebhookSchema.safeParse(payload);
  if (!event.success) {
    return NextResponse.json(
      {
        error: "Unrecognized issues webhook payload",
        issues: event.error.flatten().fieldErrors,
      },
      { status: 422 }
    );
  }

  const issueEvent = event.data;

  if (issueEvent.action !== "opened") {
    return ignored(deliveryId, `unsupported_action:${issueEvent.action}`);
  }

  const installationId = issueEvent.installation?.id;
  if (typeof installationId !== "number") {
    return ignored(deliveryId, "no_installation");
  }

  const installation = await prisma.githubInstallation.findUnique({
    where: { installationId },
    include: { user: { select: { email: true, status: true } } },
  });

  if (!installation) {
    return ignored(deliveryId, "unknown_installation");
  }

  if (installation.suspendedAt) {
    return ignored(deliveryId, "installation_suspended");
  }

  if (installation.user.status === "SUSPENDED") {
    return ignored(deliveryId, "user_suspended");
  }

  const candidateWorkflows = await prisma.workflow.findMany({
    where: {
      userId: installation.userId,
      status: "ACTIVE" satisfies WorkflowStatus,
      triggerType: "GITHUB_ISSUE_OPENED" satisfies TriggerType,
    },
    select: {
      id: true,
      userId: true,
      triggerConfig: true,
    },
  });

  const matchedWorkflows = candidateWorkflows.filter((workflow) =>
    matchesTriggerConfig(workflow.triggerConfig, issueEvent)
  );

  if (matchedWorkflows.length === 0) {
    return ignored(deliveryId, "no_matching_workflows");
  }

  const enqueued: EnqueueOutcome[] = [];
  const skipped: SkipOutcome[] = [];
  const failures: Array<{ workflowId: string; error: string }> = [];

  for (const workflow of matchedWorkflows) {
    const quota = await consumeRunQuota(installation.userId);

    if (!quota.allowed) {
      const run = await prisma.workflowRun.create({
        data: {
          workflowId: workflow.id,
          userId: workflow.userId,
          status: "SKIPPED" satisfies RunStatus,
          triggerPayload: {
            deliveryId,
            repository: issueEvent.repository.full_name,
            issueNumber: issueEvent.issue.number,
            action: issueEvent.action,
            reason: quota.reason,
          },
          error: `quota_exceeded:${quota.reason}`,
          finishedAt: new Date(),
        },
      });
      skipped.push({ workflowId: workflow.id, runId: run.id, reason: quota.reason });
      continue;
    }

    try {
      enqueued.push(
        await enqueueWorkflowRun(
          { id: workflow.id, userId: workflow.userId },
          installation.user.email,
          issueEvent,
          deliveryId
        )
      );
    } catch (error) {
      failures.push({
        workflowId: workflow.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (skipped.length > 0) {
    await notifyQuotaReached(installation.userId);
  }

  if (enqueued.length === 0 && skipped.length === 0) {
    return NextResponse.json(
      { status: "enqueue_failed", deliveryId, failures },
      { status: 502 }
    );
  }

  return NextResponse.json(
    {
      status: "accepted",
      deliveryId,
      triggeredRuns: enqueued.length,
      skippedRuns: skipped.length,
      runs: enqueued,
      skips: skipped.length > 0 ? skipped : undefined,
      failures: failures.length > 0 ? failures : undefined,
    },
    { status: 202 }
  );
}

async function handleInstallationEvent(payload: unknown): Promise<Response> {
  const event = githubInstallationWebhookSchema.safeParse(payload);
  if (!event.success) {
    return NextResponse.json(
      {
        error: "Unrecognized installation webhook payload",
        issues: event.error.flatten().fieldErrors,
      },
      { status: 422 }
    );
  }

  const { action, installation } = event.data;

  switch (action) {
    case "created": {
      const account = await prisma.account.findFirst({
        where: {
          provider: "github",
          providerAccountId: String(installation.account.id),
        },
        select: { userId: true },
      });

      if (account) {
        await prisma.githubInstallation.upsert({
          where: { installationId: installation.id },
          create: {
            installationId: installation.id,
            userId: account.userId,
            accountLogin: installation.account.login,
            accountType: installation.account.type,
          },
          update: {
            userId: account.userId,
            accountLogin: installation.account.login,
            accountType: installation.account.type,
            suspendedAt: null,
          },
        });
        return NextResponse.json(
          { status: "processed", reason: "installation_linked" },
          { status: 202 }
        );
      }

      const updated = await prisma.githubInstallation.updateMany({
        where: { installationId: installation.id },
        data: {
          accountLogin: installation.account.login,
          accountType: installation.account.type,
          suspendedAt: null,
        },
      });

      return NextResponse.json(
        {
          status: "processed",
          reason: updated.count > 0 ? "installation_updated" : "pending_setup",
        },
        { status: 202 }
      );
    }

    case "deleted": {
      await prisma.githubInstallation.deleteMany({
        where: { installationId: installation.id },
      });
      return NextResponse.json(
        { status: "processed", reason: "installation_removed" },
        { status: 202 }
      );
    }

    case "suspend": {
      await prisma.githubInstallation.updateMany({
        where: { installationId: installation.id },
        data: { suspendedAt: new Date() },
      });
      return NextResponse.json(
        { status: "processed", reason: "installation_suspended" },
        { status: 202 }
      );
    }

    case "unsuspend": {
      await prisma.githubInstallation.updateMany({
        where: { installationId: installation.id },
        data: { suspendedAt: null },
      });
      return NextResponse.json(
        { status: "processed", reason: "installation_unsuspended" },
        { status: 202 }
      );
    }

    default:
      return NextResponse.json(
        { status: "ignored", reason: `unsupported_action:${action}` },
        { status: 202 }
      );
  }
}

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  const eventName = request.headers.get("x-github-event");
  const deliveryId = request.headers.get("x-github-delivery");

  try {
    assertValidSignature(rawBody, signature);
  } catch (error) {
    const message =
      error instanceof WebhookValidationError
        ? error.message
        : "Signature validation error";
    return NextResponse.json({ error: message }, { status: 401 });
  }

  if (!deliveryId) {
    return NextResponse.json(
      { error: "Missing x-github-delivery header" },
      { status: 400 }
    );
  }

  const isFirstDelivery = await claimOnce(
    `github:webhook:${deliveryId}`,
    WEBHOOK_DEDUPE_TTL_SECONDS
  );

  if (!isFirstDelivery) {
    return NextResponse.json(
      { status: "duplicate_delivery_ignored", deliveryId },
      { status: 200 }
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Malformed JSON payload" }, { status: 400 });
  }

  if (eventName === "issues") {
    return handleIssueEvent(parsedJson, deliveryId);
  }

  if (eventName === "installation") {
    return handleInstallationEvent(parsedJson);
  }

  return NextResponse.json(
    { status: "ignored", reason: `unsupported_event:${eventName}` },
    { status: 202 }
  );
}
