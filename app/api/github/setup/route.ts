import { NextResponse } from "next/server";
import { verifyInstallState } from "../../../../lib/installState";
import { prisma } from "../../../../lib/prisma";

export const dynamic = "force-dynamic";

function redirectTo(request: Request, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, request.url));
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const installationIdRaw = url.searchParams.get("installation_id");
  const state = url.searchParams.get("state");

  const installationId = Number.parseInt(installationIdRaw ?? "", 10);
  if (!Number.isFinite(installationId) || installationId <= 0) {
    return redirectTo(request, "/signin");
  }

  const userId = state ? verifyInstallState(state) : null;
  if (!userId) {
    return redirectTo(request, "/signin");
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  if (!user) {
    return redirectTo(request, "/signin");
  }

  await prisma.githubInstallation.upsert({
    where: { installationId },
    create: { installationId, userId: user.id },
    update: { userId: user.id, suspendedAt: null },
  });

  const workflowCount = await prisma.workflow.count({
    where: { userId: user.id },
  });
  if (workflowCount === 0) {
    await prisma.workflow.create({
      data: {
        userId: user.id,
        name: "Triage new issues",
        description:
          "Summarize every new issue, rate severity, archive to Notion, and notify Slack.",
        status: "ACTIVE",
        triggerType: "GITHUB_ISSUE_OPENED",
        triggerConfig: { repositories: ["*"] },
      },
    });
  }

  return redirectTo(request, "/onboarding?github=connected");
}
