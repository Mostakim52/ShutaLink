import { redis } from "./redis";

export interface QuotaConfig {
  userDailyCap: number;
  userBurstPerMinute: number;
  globalDailyCap: number;
  keyPrefix: string;
}

export type QuotaRejectionReason = "user_burst" | "user_daily_cap" | "global_daily_cap";

export type QuotaCheckResult =
  | { allowed: true }
  | { allowed: false; reason: QuotaRejectionReason };

const BURST_TTL_SECONDS = 120;
const DAILY_TTL_SECONDS = 60 * 60 * 48;

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getQuotaConfig(env: NodeJS.ProcessEnv = process.env): QuotaConfig {
  return {
    userDailyCap: readPositiveInt(env.LIMIT_USER_DAILY, 15),
    userBurstPerMinute: readPositiveInt(env.LIMIT_USER_BURST_PER_MIN, 5),
    globalDailyCap: readPositiveInt(env.LIMIT_GLOBAL_DAILY, 150),
    keyPrefix: env.QUOTA_KEY_PREFIX ?? "quota",
  };
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function minuteKey(date: Date): string {
  return date.toISOString().slice(0, 16);
}

async function incrementWithTtl(key: string, ttlSeconds: number): Promise<number> {
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, ttlSeconds);
  }
  return count;
}

export async function consumeRunQuota(
  userId: string,
  now: Date = new Date(),
  config: QuotaConfig = getQuotaConfig()
): Promise<QuotaCheckResult> {
  const burstKey = `${config.keyPrefix}:burst:${userId}:${minuteKey(now)}`;
  const burstCount = await incrementWithTtl(burstKey, BURST_TTL_SECONDS);
  if (burstCount > config.userBurstPerMinute) {
    return { allowed: false, reason: "user_burst" };
  }

  const userKey = `${config.keyPrefix}:user:${userId}:${dayKey(now)}`;
  const userCount = await incrementWithTtl(userKey, DAILY_TTL_SECONDS);
  if (userCount > config.userDailyCap) {
    return { allowed: false, reason: "user_daily_cap" };
  }

  const globalKey = `${config.keyPrefix}:global:${dayKey(now)}`;
  const globalCount = await incrementWithTtl(globalKey, DAILY_TTL_SECONDS);
  if (globalCount > config.globalDailyCap) {
    return { allowed: false, reason: "global_daily_cap" };
  }

  return { allowed: true };
}

export async function isGlobalCapReached(
  now: Date = new Date(),
  config: QuotaConfig = getQuotaConfig()
): Promise<boolean> {
  const globalKey = `${config.keyPrefix}:global:${dayKey(now)}`;
  const raw = await redis.get(globalKey);
  const count = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(count) && count >= config.globalDailyCap;
}
