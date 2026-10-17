"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  checkToolkitConnection,
  saveIntegrationMetadata,
  startToolkitConnect,
} from "../../lib/connect";
import { requireUser } from "../../lib/session";

type Toolkit = "notion" | "slack";

function parseToolkit(raw: FormDataEntryValue | null): Toolkit {
  const value = String(raw ?? "");
  if (value !== "notion" && value !== "slack") {
    throw new Error(`Unknown toolkit: ${value}`);
  }
  return value;
}

function toolkitFromForm(formData: FormData): Toolkit {
  try {
    return parseToolkit(formData.get("toolkit"));
  } catch (error) {
    console.error("Onboarding action received an invalid toolkit", error);
    redirect("/onboarding?error=invalid_request");
  }
}

export async function startConnect(formData: FormData): Promise<void> {
  const user = await requireUser();
  const toolkit = toolkitFromForm(formData);

  let redirectUrl: string;
  try {
    ({ redirectUrl } = await startToolkitConnect(user.id, toolkit));
  } catch (error) {
    console.error(`Composio connect failed for ${toolkit}`, error);
    redirect(`/onboarding?error=connect_unavailable&toolkit=${toolkit}`);
  }

  redirect(redirectUrl);
}

export async function refreshConnection(formData: FormData): Promise<void> {
  const user = await requireUser();
  const toolkit = toolkitFromForm(formData);

  try {
    await checkToolkitConnection(user.id, toolkit);
  } catch (error) {
    console.error(`Composio status check failed for ${toolkit}`, error);
    redirect(`/onboarding?error=refresh_failed&toolkit=${toolkit}`);
  }

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
