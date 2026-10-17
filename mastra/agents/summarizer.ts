import { Agent } from "@mastra/core/agent";
import { z } from "zod";

export const issueAnalysisSchema = z.object({
  title: z
    .string()
    .min(1)
    .describe("Normalized, imperative-mood title for the issue (max 80 characters)"),
  body: z
    .string()
    .min(1)
    .describe("Cleaned-up issue body with noise removed but all technical detail preserved"),
  severity: z
    .enum(["low", "medium", "high"])
    .describe(
      "Operational severity: high = security vulnerability, data loss, production outage, or payment breakage; medium = functional bug affecting multiple users or core feature; low = cosmetic, documentation, question, or single-user edge case"
    ),
  summary: z
    .string()
    .min(1)
    .max(1200)
    .describe("Executive summary of the issue in at most 120 words"),
});

export type IssueAnalysis = z.infer<typeof issueAnalysisSchema>;

export const issueSummarizerAgent = new Agent({
  id: "issue-summarizer",
  name: "Issue Summarizer",
  instructions: [
    "You are a senior triage engineer analyzing newly opened GitHub issues.",
    "Given a raw issue report, produce a structured analysis.",
    "Normalize the title into a short imperative statement of the problem or request.",
    "Clean the body: strip greetings, duplicate whitespace and irrelevant chatter, keep reproduction steps, stack traces, environment details and expected vs actual behavior.",
    "Assign severity strictly by impact: security vulnerabilities, data loss, production outages and payment failures are always high; broken core functionality is medium; cosmetic issues, docs and questions are low.",
    "The summary must state what happened, the affected surface, and the likely blast radius in at most 120 words.",
    "Never invent facts that are not present in the issue report.",
  ].join("\n"),
  model: "groq/openai/gpt-oss-120b",
});

export async function analyzeGithubIssue(input: {
  repository: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string | null;
  reporterLogin?: string;
}): Promise<IssueAnalysis> {
  const prompt = [
    `Repository: ${input.repository}`,
    `Issue #${input.issueNumber}: ${input.issueTitle}`,
    input.reporterLogin ? `Opened by: @${input.reporterLogin}` : null,
    "",
    "Issue body:",
    "---",
    input.issueBody?.trim() || "(empty body)",
    "---",
    "",
    "Analyze this issue and respond with the structured analysis.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const response = await issueSummarizerAgent.generate(prompt, {
    structuredOutput: {
      schema: issueAnalysisSchema,
    },
  });

  if (!response.object) {
    throw new Error("Issue summarizer did not return structured output");
  }

  return response.object;
}
