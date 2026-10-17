import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signInstallState, verifyInstallState } from "../lib/installState";

const BASE_TIME = new Date("2026-10-17T12:00:00.000Z");

describe("signInstallState / verifyInstallState", () => {
  it("round-trips a user id", () => {
    const state = signInstallState("user_123", BASE_TIME);
    expect(verifyInstallState(state, BASE_TIME)).toBe("user_123");
  });

  it("still verifies within the validity window", () => {
    const state = signInstallState("user_123", BASE_TIME);
    const shortlyAfter = new Date(BASE_TIME.getTime() + 10 * 60 * 1000);
    expect(verifyInstallState(state, shortlyAfter)).toBe("user_123");
  });

  it("rejects expired states", () => {
    const state = signInstallState("user_123", BASE_TIME);
    const tooLate = new Date(BASE_TIME.getTime() + 16 * 60 * 1000);
    expect(verifyInstallState(state, tooLate)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const state = signInstallState("user_123", BASE_TIME);
    const tampered = state.slice(0, -2) + (state.endsWith("aa") ? "bb" : "aa");
    expect(verifyInstallState(tampered, BASE_TIME)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const state = signInstallState("user_123", BASE_TIME);
    const [encoded, signature] = state.split(".");
    const forged = Buffer.from(`attacker_1.${BASE_TIME.getTime()}`, "utf8").toString(
      "base64url"
    );
    expect(verifyInstallState(`${forged}.${signature}`, BASE_TIME)).toBeNull();
    expect(forged).not.toBe(encoded);
  });

  it("rejects malformed input", () => {
    expect(verifyInstallState("", BASE_TIME)).toBeNull();
    expect(verifyInstallState("not-a-state", BASE_TIME)).toBeNull();
    expect(verifyInstallState("a.b.c", BASE_TIME)).toBeNull();
  });

  it("rejects a state whose timestamp is not numeric", () => {
    const encoded = Buffer.from("user_123.not-a-timestamp", "utf8").toString("base64url");
    const signature = createHmac("sha256", process.env.AUTH_SECRET ?? "")
      .update(encoded)
      .digest("base64url");
    expect(verifyInstallState(`${encoded}.${signature}`, BASE_TIME)).toBeNull();
  });
});
