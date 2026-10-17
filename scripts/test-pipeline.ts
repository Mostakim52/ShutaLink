import { PrismaClient } from "@prisma/client";
import { tasks } from "@trigger.dev/sdk";
import { PROCESS_GITHUB_ISSUE_TASK_ID, type WorkflowTaskPayload } from "../lib/types";

const prisma = new PrismaClient();

const DEMO_EMAIL = "demo@chronoweave.dev";

async function main(): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email: DEMO_EMAIL } });
  if (!user) {
    throw new Error("Demo user not found. Run: npm run db:seed");
  }

  const workflow = await prisma.workflow.findFirst({
    where: { userId: user.id, status: "ACTIVE" },
    orderBy: { createdAt: "asc" },
  });
  if (!workflow) {
    throw new Error("No ACTIVE workflow found. Run: npm run db:seed");
  }

  const run = await prisma.workflowRun.create({
    data: {
      workflowId: workflow.id,
      userId: user.id,
      status: "PENDING",
      triggerPayload: { source: "scripts/test-pipeline.ts" },
    },
  });

  const payload: WorkflowTaskPayload = {
    runId: run.id,
    workflowId: workflow.id,
    userId: user.id,
    tenantEmail: user.email,
    repository: "acme/checkout-service",
    issueNumber: 482,
    issueId: 999001,
    issueTitle: "Checkout crashes and customer orders are lost",
    issueBody:
      "Since the latest deploy (v2.14.0) checkout throws 'TypeError: cannot read properties of undefined (reading total)'. Customers report orders are missing and support is being flooded. Started around 10am, affects roughly 30% of users. Rollback did not help.",
    issueUrl: "https://github.com/acme/checkout-service/issues/482",
    reporterLogin: "frustrated-customer",
  };

  const handle = await tasks.trigger(PROCESS_GITHUB_ISSUE_TASK_ID, payload, {
    idempotencyKey: `manual-test-${run.id}`,
  });

  await prisma.workflowRun.update({
    where: { id: run.id },
    data: { triggerRunId: handle.id },
  });

  console.log("");
  console.log("Test issue triggered successfully");
  console.log(`- WorkflowRun ID:    ${run.id}`);
  console.log(`- Trigger.dev run:   ${handle.id}`);
  console.log("");
  console.log("Now watch the 'npm run trigger:dev' terminal for the live execution.");
  console.log("Inspect the result afterwards with: npm run db:studio");
  console.log("  (check the WorkflowRun row and its ExecutionLog entries)");
}

main()
  .catch((error) => {
    console.error("Pipeline test failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
