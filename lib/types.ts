import { z } from "zod";

export const PROCESS_GITHUB_ISSUE_TASK_ID = "process-github-issue" as const;

export type IssueSeverity = "low" | "medium" | "high";

export const githubIssueWebhookSchema = z.object({
  action: z.string(),
  issue: z.object({
    id: z.number(),
    number: z.number(),
    title: z.string(),
    body: z.string().nullable(),
    html_url: z.string().url(),
    state: z.string(),
    labels: z
      .array(
        z.object({
          name: z.string().nullable(),
        })
      )
      .optional()
      .default([]),
    user: z
      .object({
        login: z.string(),
      })
      .optional(),
    created_at: z.string().optional(),
  }),
  repository: z.object({
    id: z.number(),
    full_name: z.string(),
    html_url: z.string().url(),
    private: z.boolean().optional().default(false),
  }),
  sender: z
    .object({
      login: z.string(),
    })
    .optional(),
});

export type GithubIssueWebhookEvent = z.infer<typeof githubIssueWebhookSchema>;

export const workflowTriggerConfigSchema = z.object({
  repositories: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$|^\*$/)).min(1),
  labels: z.array(z.string()).max(10).optional(),
});

export type WorkflowTriggerConfig = z.infer<typeof workflowTriggerConfigSchema>;

export const workflowTaskPayloadSchema = z.object({
  runId: z.string().uuid(),
  workflowId: z.string(),
  userId: z.string(),
  tenantEmail: z.string().email(),
  repository: z.string(),
  issueNumber: z.number().int().positive(),
  issueId: z.number(),
  issueTitle: z.string(),
  issueBody: z.string().nullable(),
  issueUrl: z.string().url(),
  reporterLogin: z.string().optional(),
});

export type WorkflowTaskPayload = z.infer<typeof workflowTaskPayloadSchema>;

export interface NotionArchiveResult {
  pageId: string;
  url: string;
}

export interface SlackNotificationResult {
  channel: string;
  threadTs?: string;
}

export interface ProcessGithubIssueResult {
  executionPath: "slack-first" | "notion-first";
  analysis: {
    title: string;
    severity: IssueSeverity;
    summary: string;
  };
  notion: NotionArchiveResult;
  slack: SlackNotificationResult;
}
