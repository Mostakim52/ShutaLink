import { createHmac, timingSafeEqual } from "node:crypto";
import type { WorkflowStatus, TriggerType } from "@prisma/client";
import { idempotencyKeys, tasks } from "@trigger.dev/sdk";
import { NextResponse } from "next/server";
import { claimOnce } from "../../../../lib/redis";
import { prisma } from "../../../../lib/prisma";
import {
  PROCESS_GITHUB_ISSUE_TASK_ID,
  githubIssueWebhookSchema,
  workflowTriggerConfigSchema,
  type GithubIssueWebhookEvent,
  type WorkflowTaskPayload,
} from "../../../../lib/types";

export const dynamic = "force-dynamic";

const WEBHOOK_DEDUPE_TTL_SECONDS = 60 * 60 * 24;

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
    return NextResponse.json({ error: "Missing x-github-delivery header" }, { status: 400 });
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

  if (eventName !== "issues") {
    return NextResponse.json(
      { status: "ignored", reason: `unsupported_event:${eventName}` },
      { status: 202 }
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Malformed JSON payload" }, { status: 400 });
  }

  const event = githubIssueWebhookSchema.safeParse(parsedJson);
  if (!event.success) {
    return NextResponse.json(
      { error: "Unrecognized issues webhook payload", issues: event.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const issueEvent = event.data;

  if (issueEvent.action !== "opened") {
    return NextResponse.json(
      { status: "ignored", reason: `unsupported_action:${issueEvent.action}` },
      { status: 202 }
    );
  }

  const candidateWorkflows = await prisma.workflow.findMany({
    where: {
      status: "ACTIVE" satisfies WorkflowStatus,
      triggerType: "GITHUB_ISSUE_OPENED" satisfies TriggerType,
    },
    select: {
      id: true,
      userId: true,
      triggerConfig: true,
      user: { select: { email: true } },
    },
  });

  const matchedWorkflows = candidateWorkflows.filter((workflow) =>
    matchesTriggerConfig(workflow.triggerConfig, issueEvent)
  );

  if (matchedWorkflows.length === 0) {
    return NextResponse.json(
      { status: "no_matching_workflows", deliveryId },
      { status: 202 }
    );
  }

  const enqueued: EnqueueOutcome[] = [];
  const failures: Array<{ workflowId: string; error: string }> = [];

  for (const workflow of matchedWorkflows) {
    try {
      enqueued.push(
        await enqueueWorkflowRun(
          { id: workflow.id, userId: workflow.userId },
          workflow.user.email,
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

  if (enqueued.length === 0) {
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
      runs: enqueued,
      failures: failures.length > 0 ? failures : undefined,
    },
    { status: 202 }
  );
}
