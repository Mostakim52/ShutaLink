"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  checkToolkitConnection,
  saveIntegrationMetadata,
  startToolkitConnect,
} from "../../lib/connect";
import { requireUser } from "../../lib/session";

function parseToolkit(raw: FormDataEntryValue | null): "notion" | "slack" {
  const value = String(raw ?? "");
  if (value !== "notion" && value !== "slack") {
    throw new Error(`Unknown toolkit: ${value}`);
  }
  return value;
}

export async function startConnect(formData: FormData): Promise<void> {
  const user = await requireUser();
  const toolkit = parseToolkit(formData.get("toolkit"));
  const { redirectUrl } = await startToolkitConnect(user.id, toolkit);
  redirect(redirectUrl);
}

export async function refreshConnection(formData: FormData): Promise<void> {
  const user = await requireUser();
  const toolkit = parseToolkit(formData.get("toolkit"));
  await checkToolkitConnection(user.id, toolkit);
  revalidatePath("/onboarding");
}

export async function saveIntegrationSettings(formData: FormData): Promise<void> {
  const user = await requireUser();
  const toolkit = parseToolkit(formData.get("toolkit"));

  if (toolkit === "notion") {
    const notionParentPageId = String(
      formData.get("notionParentPageId") ?? ""
    ).trim();
    await saveIntegrationMetadata(user.id, "NOTION", { notionParentPageId });
  } else {
    const slackChannel =
      String(formData.get("slackChannel") ?? "").trim() || "#general";
    const slackAlertChannel =
      String(formData.get("slackAlertChannel") ?? "").trim() || "#incident-alerts";
    await saveIntegrationMetadata(user.id, "SLACK", {
      slackChannel,
      slackAlertChannel,
    });
  }

  revalidatePath("/onboarding");
}
