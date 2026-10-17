import Redis from "ioredis";

const globalForRedis = globalThis as unknown as {
  redis?: Redis;
};

function createRedisClient(): Redis {
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  const client = new Redis(url, {
    maxRetriesPerRequest: 3,
    enableAutoPipelining: true,
    lazyConnect: false,
  });
  client.on("error", (error) => {
    console.error("[redis] connection error:", error.message);
  });
  return client;
}

export const redis = globalForRedis.redis ?? createRedisClient();

if (process.env.NODE_ENV !== "production") {
  globalForRedis.redis = redis;
}

export async function claimOnce(key: string, ttlSeconds: number): Promise<boolean> {
  const result = await redis.set(key, Date.now().toString(), "EX", ttlSeconds, "NX");
  return result === "OK";
}
