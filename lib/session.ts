import { redirect } from "next/navigation";
import { auth } from "../auth";
import { prisma } from "./prisma";

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return null;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, image: true, status: true },
  });

  if (!user || user.status === "SUSPENDED") {
    return null;
  }

  return { id: user.id, email: user.email, name: user.name, image: user.image };
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) {
    redirect("/signin");
  }
  return user;
}
