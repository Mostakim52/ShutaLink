import {
  IntegrationProvider,
  TriggerType,
  WorkflowStatus,
} from "@prisma/client";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const DEMO_EMAIL = "demo@chronoweave.dev";

async function seedUser() {
  return prisma.user.upsert({
    where: { email: DEMO_EMAIL },
    update: {},
    create: {
      email: DEMO_EMAIL,
      name: "Demo User",
    },
  });
}

async function seedWorkflow(userId: string) {
  const existing = await prisma.workflow.findFirst({
    where: { userId, name: "Triage GitHub issues" },
  });

  if (existing) {
    console.log(`Workflow already exists: ${existing.id}`);
    return existing;
  }

  const workflow = await prisma.workflow.create({
    data: {
      userId,
      name: "Triage GitHub issues",
      description:
        "When a GitHub issue is opened: summarize with AI, archive to Notion, notify Slack. High severity alerts Slack first.",
      status: WorkflowStatus.ACTIVE,
      triggerType: TriggerType.GITHUB_ISSUE_OPENED,
      triggerConfig: {
        repositories: ["*"],
      },
    },
  });

  console.log(`Created workflow: ${workflow.id}`);
  return workflow;
}

async function seedIntegration(
  userId: string,
  provider: IntegrationProvider,
  envVarName: string
): Promise<void> {
  const connectedAccountId = process.env[envVarName];

  if (!connectedAccountId) {
    console.warn(
      `[skip] ${provider}: set ${envVarName} in .env to your Composio connected account ID, then re-run this seed.`
    );
    return;
  }

  await prisma.integrationConfig.upsert({
    where: { userId_provider: { userId, provider } },
    update: { connectedAccountId, isActive: true },
    create: {
      userId,
      provider,
      connectedAccountId,
      isActive: true,
    },
  });

  console.log(`Integration ready: ${provider} -> ${connectedAccountId}`);
}

async function main(): Promise<void> {
  const user = await seedUser();
  console.log(`User ready: ${user.email} (${user.id})`);

  await seedWorkflow(user.id);
  await seedIntegration(user.id, IntegrationProvider.NOTION, "COMPOSIO_NOTION_CONNECTED_ACCOUNT_ID");
  await seedIntegration(user.id, IntegrationProvider.SLACK, "COMPOSIO_SLACK_CONNECTED_ACCOUNT_ID");

  console.log("\nSeed complete. Workflows with status ACTIVE will fire on matching GitHub issues.");
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
