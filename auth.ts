import { PrismaAdapter } from "@auth/prisma-adapter";
import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { prisma } from "./lib/prisma";

interface GitHubProfileLike {
  id: number | string;
  login?: string;
  name?: string | null;
  email?: string | null;
  avatar_url?: string;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  trustHost: true,
  session: { strategy: "jwt" },
  providers: [
    GitHub({
      clientId: process.env.GITHUB_APP_CLIENT_ID,
      clientSecret: process.env.GITHUB_APP_CLIENT_SECRET,
      profile(profile) {
        const githubProfile = profile as GitHubProfileLike;
        const login = githubProfile.login ?? githubProfile.name ?? "github-user";
        return {
          id: String(githubProfile.id),
          name: githubProfile.name ?? login,
          email:
            githubProfile.email ??
            `${githubProfile.id}+${login}@users.noreply.github.com`,
          image: githubProfile.avatar_url ?? null,
        };
      },
    }),
  ],
  callbacks: {
    async signIn({ user }) {
      if (!user?.id) {
        return false;
      }
      const dbUser = await prisma.user.findUnique({
        where: { id: user.id },
        select: { status: true },
      });
      return dbUser?.status !== "SUSPENDED";
    },
    session({ session, token }) {
      if (token.sub) {
        session.user.id = token.sub;
      }
      return session;
    },
  },
  pages: {
    signIn: "/signin",
  },
});
