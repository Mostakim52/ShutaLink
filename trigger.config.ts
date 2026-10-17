import { defineConfig } from "@trigger.dev/sdk";
import { prismaExtension } from "@trigger.dev/build/extensions/prisma";

const projectRef = (process.env.TRIGGER_PROJECT_REF ?? "").trim();

export default defineConfig({
  project: projectRef.length > 0 ? projectRef : "proj_ddqixqwnmjvsdlbgcrdm",
  runtime: "node",
  logLevel: "log",
  maxDuration: -1,
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 30000,
      factor: 2,
      randomize: true,
    },
  },
  dirs: ["./trigger"],
  build: {
    extensions: [
      prismaExtension({
        mode: "legacy",
        schema: "prisma/schema.prisma",
      }),
    ],
  },
});
