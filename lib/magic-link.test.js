import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createMagicLinkToken, verifyMagicLinkToken } from "./magic-link.js";

const SECRET = "test-secret-do-not-use-in-prod";

describe("magic link tokens", () => {
  test("round-trips a valid token", () => {
    const token = createMagicLinkToken(SECRET, { stripeCustomerId: "cus_123", email: "a@b.com" });
    const verified = verifyMagicLinkToken(SECRET, token);
    assert.equal(verified.ok, true);
    assert.equal(verified.stripeCustomerId, "cus_123");
    assert.equal(verified.email, "a@b.com");
  });

  test("rejects a tampered payload", () => {
    const token = createMagicLinkToken(SECRET, { stripeCustomerId: "cus_123", email: "a@b.com" });
    const [, sig] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ c: "cus_999", e: "a@b.com", exp: Date.now() + 100000 }),
    ).toString("base64url");
    const verified = verifyMagicLinkToken(SECRET, `${tamperedPayload}.${sig}`);
    assert.equal(verified.ok, false);
  });

  test("rejects a token signed with the wrong secret", () => {
    const token = createMagicLinkToken("some-other-secret", { stripeCustomerId: "cus_1", email: "a@b.com" });
    const verified = verifyMagicLinkToken(SECRET, token);
    assert.equal(verified.ok, false);
  });

  test("rejects an expired token", () => {
    const token = createMagicLinkToken(SECRET, { stripeCustomerId: "cus_1", email: "a@b.com", ttlMs: -1 });
    const verified = verifyMagicLinkToken(SECRET, token);
    assert.equal(verified.ok, false);
    assert.equal(verified.reason, "token expired");
  });

  test("rejects garbage input without throwing", () => {
    assert.equal(verifyMagicLinkToken(SECRET, "not-a-real-token").ok, false);
    assert.equal(verifyMagicLinkToken(SECRET, "").ok, false);
  });
});
