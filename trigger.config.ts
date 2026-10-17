import { defineConfig } from "@trigger.dev/sdk";

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
});
