import { createHmac, timingSafeEqual } from "node:crypto";

const STATE_TTL_MS = 15 * 60 * 1000;
const FUTURE_SKEW_MS = 60 * 1000;

function getSecret(): string | null {
  return process.env.AUTH_SECRET || null;
}

export function signInstallState(userId: string, now: Date = new Date()): string {
  const secret = getSecret();
  if (!secret) {
    throw new Error("AUTH_SECRET is not configured");
  }

  const encoded = Buffer.from(`${userId}.${now.getTime()}`, "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyInstallState(state: string, now: Date = new Date()): string | null {
  const secret = getSecret();
  if (!secret || !state) {
    return null;
  }

  const parts = state.split(".");
  if (parts.length !== 2) {
    return null;
  }

  const [encoded, signature] = parts;
  const expected = createHmac("sha256", secret).update(encoded).digest("base64url");
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return null;
  }

  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  const separatorIndex = decoded.lastIndexOf(".");
  if (separatorIndex <= 0) {
    return null;
  }

  const userId = decoded.slice(0, separatorIndex);
  const issuedAt = Number.parseInt(decoded.slice(separatorIndex + 1), 10);
  if (!userId || !Number.isFinite(issuedAt)) {
    return null;
  }

  const age = now.getTime() - issuedAt;
  if (age > STATE_TTL_MS || age < -FUTURE_SKEW_MS) {
    return null;
  }

  return userId;
}
