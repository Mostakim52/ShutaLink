import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { consumeRunQuota, isGlobalCapReached, type QuotaConfig } from "../lib/limits";

const baseConfig: QuotaConfig = {
  userDailyCap: 15,
  userBurstPerMinute: 5,
  globalDailyCap: 150,
  keyPrefix: "quota",
};

function freshUserId(): string {
  return `test-${randomUUID()}`;
}

function isolatedConfig(overrides: Partial<QuotaConfig> = {}): QuotaConfig {
  return {
    ...baseConfig,
    keyPrefix: `test-quota-${randomUUID()}`,
    ...overrides,
  };
}

describe("consumeRunQuota", () => {
  it("allows runs within all caps", async () => {
    const userId = freshUserId();
    const config = isolatedConfig();
    const now = new Date();

    for (let i = 0; i < 3; i += 1) {
      const result = await consumeRunQuota(userId, now, config);
      expect(result.allowed).toBe(true);
    }
  });

  it("rejects with user_burst after the burst cap within the same minute", async () => {
    const userId = freshUserId();
    const config = isolatedConfig({ userBurstPerMinute: 2 });
    const now = new Date();

    expect((await consumeRunQuota(userId, now, config)).allowed).toBe(true);
    expect((await consumeRunQuota(userId, now, config)).allowed).toBe(true);

    const third = await consumeRunQuota(userId, now, config);
    expect(third).toEqual({ allowed: false, reason: "user_burst" });
  });

  it("allows again once the burst window rolls to the next minute", async () => {
    const userId = freshUserId();
    const config = isolatedConfig({ userBurstPerMinute: 1 });
    const now = new Date("2026-10-17T12:00:00.000Z");

    expect((await consumeRunQuota(userId, now, config)).allowed).toBe(true);
    expect((await consumeRunQuota(userId, now, config)).allowed).toBe(false);

    const nextMinute = new Date("2026-10-17T12:01:01.000Z");
    expect((await consumeRunQuota(userId, nextMinute, config)).allowed).toBe(true);
  });

  it("rejects with user_daily_cap when the user's day cap is exceeded", async () => {
    const userId = freshUserId();
    const config = isolatedConfig({ userDailyCap: 2, userBurstPerMinute: 100 });
    const now = new Date();

    expect((await consumeRunQuota(userId, now, config)).allowed).toBe(true);
    expect((await consumeRunQuota(userId, now, config)).allowed).toBe(true);

    const third = await consumeRunQuota(userId, now, config);
    expect(third).toEqual({ allowed: false, reason: "user_daily_cap" });
  });

  it("rejects with global_daily_cap once the shared daily budget is spent", async () => {
    const userA = freshUserId();
    const userB = freshUserId();
    const config = isolatedConfig({
      userDailyCap: 100,
      userBurstPerMinute: 100,
      globalDailyCap: 2,
    });
    const now = new Date();

    expect((await consumeRunQuota(userA, now, config)).allowed).toBe(true);
    expect((await consumeRunQuota(userB, now, config)).allowed).toBe(true);

    const third = await consumeRunQuota(userA, now, config);
    expect(third).toEqual({ allowed: false, reason: "global_daily_cap" });
  });

  it("resets daily caps on the next UTC day", async () => {
    const userId = freshUserId();
    const config = isolatedConfig({
      userDailyCap: 1,
      userBurstPerMinute: 100,
      globalDailyCap: 1,
    });
    const day1 = new Date("2026-10-17T23:00:00.000Z");
    const day2 = new Date("2026-10-18T01:00:00.000Z");

    expect((await consumeRunQuota(userId, day1, config)).allowed).toBe(true);
    expect((await consumeRunQuota(userId, day1, config)).allowed).toBe(false);

    const nextDay = await consumeRunQuota(userId, day2, config);
    expect(nextDay.allowed).toBe(true);
  });
});

describe("isGlobalCapReached", () => {
  it("is false before consumption and true once the global budget is spent", async () => {
    const userId = freshUserId();
    const config = isolatedConfig({
      userDailyCap: 100,
      userBurstPerMinute: 100,
      globalDailyCap: 1,
    });
    const now = new Date("2026-10-17T09:00:00.000Z");

    expect(await isGlobalCapReached(now, config)).toBe(false);

    await consumeRunQuota(userId, now, config);

    expect(await isGlobalCapReached(now, config)).toBe(true);
  });
});
