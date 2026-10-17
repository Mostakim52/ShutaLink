import { RunStatus, type Prisma } from "@prisma/client";
import { logger, task } from "@trigger.dev/sdk";
import { createNotionPage, resolveSlackChannel, getIntegrationContext, sendSlackMessage } from "../lib/composio";
import type {
  IssueSeverity,
  NotionArchiveResult,
  ProcessGithubIssueResult,
  SlackNotificationResult,
  WorkflowTaskPayload,
} from "../lib/types";
import { analyzeGithubIssue, type IssueAnalysis } from "../mastra/agents/summarizer";
import { prisma } from "../lib/prisma";

const MAX_ATTEMPTS = 3;
const RETRY_FACTOR = 2;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30_000;

async function appendLog(
  runId: string,
  step: string,
  level: "INFO" | "WARN" | "ERROR",
  message: string,
  data?: Record<string, unknown>
): Promise<void> {
  logger.info(message, { runId, step, ...data });
  await prisma.executionLog.create({
    data: {
      runId,
      step,
      level,
      message,
      data: data as Prisma.InputJsonValue | undefined,
    },
  });
}

function renderNotionContent(payload: WorkflowTaskPayload, analysis: IssueAnalysis): string {
  return [
    `# [${payload.repository}] #${payload.issueNumber}: ${analysis.title}`,
    "",
    `**Severity:** ${analysis.severity.toUpperCase()}`,
    `**Reporter:** ${payload.reporterLogin ? `@${payload.reporterLogin}` : "unknown"}`,
    `**Source:** ${payload.issueUrl}`,
    "",
    "## AI Summary",
    analysis.summary,
    "",
    "## Original Report",
    payload.issueBody?.trim() || "(empty body)",
    "",
    "---",
    "_Archived automatically by Chronoweave._",
  ].join("\n");
}

async function archiveToNotion(
  runId: string,
  payload: WorkflowTaskPayload,
  analysis: IssueAnalysis
): Promise<NotionArchiveResult> {
  const page = await createNotionPage({
    userId: payload.userId,
    title: `[${analysis.severity.toUpperCase()}] ${analysis.title} (#${payload.issueNumber})`,
    markdownContent: renderNotionContent(payload, analysis),
  });
  await appendLog(runId, "notion", "INFO", "Stored issue analysis in Notion", {
    pageId: page.pageId,
    url: page.url,
  });
  return page;
}

async function notifySlack(
  runId: string,
  payload: WorkflowTaskPayload,
  analysis: IssueAnalysis,
  purpose: "notifications" | "alerts"
): Promise<SlackNotificationResult> {
  const context = await getIntegrationContext(payload.userId, "SLACK");
  const channel = resolveSlackChannel(context.metadata, purpose);

  const header =
    purpose === "alerts"
      ? `:rotating_light: *High severity issue in ${payload.repository}*`
      : `:inbox_tray: New issue triaged in ${payload.repository}`;

  const message = [
    header,
    "",
    `*#${payload.issueNumber} — ${analysis.title}*`,
    `*Severity:* ${analysis.severity}`,
    "",
    analysis.summary,
    "",
    payload.issueUrl,
  ].join("\n");

  const result = await sendSlackMessage({
    userId: payload.userId,
    channel,
    text: message,
  });

  await appendLog(runId, "slack", "INFO", "Sent Slack notification", {
    channel: result.channel,
    threadTs: result.threadTs,
    purpose,
  });
  return result;
}

export const processGithubIssue = task({
  id: "process-github-issue",
  description:
    "Summarizes a GitHub issue with AI, then branches: high severity alerts Slack first before archiving to Notion; everything else archives to Notion first.",
  retry: {
    maxAttempts: MAX_ATTEMPTS,
    factor: RETRY_FACTOR,
    minTimeoutInMs: MIN_TIMEOUT_MS,
    maxTimeoutInMs: MAX_TIMEOUT_MS,
    randomize: true,
  },
  queue: {
    concurrencyLimit: 20,
  },
  maxDuration: 300,
  run: async (payload: WorkflowTaskPayload, { ctx }): Promise<ProcessGithubIssueResult> => {
    const run = await prisma.workflowRun.findUnique({
      where: { id: payload.runId },
      include: { workflow: true },
    });

    if (!run) {
      throw new Error(`WorkflowRun ${payload.runId} not found`);
    }

    if (run.status === RunStatus.SUCCEEDED) {
      logger.info("Run already succeeded, skipping duplicate attempt", {
        runId: run.id,
        attempt: ctx.attempt.number,
      });
      throw new Error("Run already completed successfully");
    }

    if (ctx.attempt.number > 1) {
      await appendLog(
        run.id,
        "orchestration",
        "WARN",
        `Retrying workflow execution (attempt ${ctx.attempt.number}/${MAX_ATTEMPTS})`
      );
    }

    await prisma.workflowRun.update({
      where: { id: run.id },
      data: { status: RunStatus.RUNNING, startedAt: new Date() },
    });

    try {
      await appendLog(run.id, "summarize", "INFO", "Starting AI analysis of GitHub issue");

      const analysis = await analyzeGithubIssue({
        repository: payload.repository,
        issueNumber: payload.issueNumber,
        issueTitle: payload.issueTitle,
        issueBody: payload.issueBody,
        reporterLogin: payload.reporterLogin,
      });

      await appendLog(run.id, "summarize", "INFO", `AI analysis complete (severity=${analysis.severity})`, {
        severity: analysis.severity,
      });

      const severity: IssueSeverity = analysis.severity;
      const highSeverity = severity === "high";

      let notion: NotionArchiveResult;
      let slack: SlackNotificationResult;

      if (highSeverity) {
        slack = await notifySlack(run.id, payload, analysis, "alerts");
        notion = await archiveToNotion(run.id, payload, analysis);
      } else {
        notion = await archiveToNotion(run.id, payload, analysis);
        slack = await notifySlack(run.id, payload, analysis, "notifications");
      }

      const result: ProcessGithubIssueResult = {
        executionPath: highSeverity ? "slack-first" : "notion-first",
        analysis: {
          title: analysis.title,
          severity: analysis.severity,
          summary: analysis.summary,
        },
        notion,
        slack,
      };

      await appendLog(run.id, "orchestration", "INFO", `Workflow finished via ${result.executionPath}`, {
        executionPath: result.executionPath,
      });

      await prisma.workflowRun.update({
        where: { id: run.id },
        data: {
          status: RunStatus.SUCCEEDED,
          finishedAt: new Date(),
          error: null,
          result: result as unknown as Prisma.InputJsonValue,
        },
      });

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isFinalAttempt = ctx.attempt.number >= MAX_ATTEMPTS;

      await appendLog(
        run.id,
        "orchestration",
        "ERROR",
        isFinalAttempt
          ? `Workflow failed after ${MAX_ATTEMPTS} attempts: ${message}`
          : `Attempt ${ctx.attempt.number}/${MAX_ATTEMPTS} failed: ${message}`,
        { attempt: ctx.attempt.number }
      );

      if (isFinalAttempt) {
        await prisma.workflowRun.update({
          where: { id: run.id },
          data: {
            status: RunStatus.FAILED,
            finishedAt: new Date(),
            error: message,
          },
        });
      }

      throw error;
    }
  },
});
