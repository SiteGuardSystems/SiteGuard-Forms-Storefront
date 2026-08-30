// Stateless, expiring magic-link tokens — no accounts/passwords/sessions
// table yet (that's a deliberate v1 choice; a real login system can replace
// this later). A token is just a signed, self-contained claim: "this
// stripeCustomerId, until this time" — verified with an HMAC so nothing
// needs to be looked up to check it's genuine.
import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function sign(secret, payload) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** @returns {string} a URL-safe token encoding {stripeCustomerId, email, expiresAt}. */
export function createMagicLinkToken(secret, { stripeCustomerId, email, ttlMs = DEFAULT_TTL_MS }) {
  const payload = JSON.stringify({
    c: stripeCustomerId,
    e: email,
    exp: Date.now() + ttlMs,
  });
  const encodedPayload = Buffer.from(payload, "utf8").toString("base64url");
  const signature = sign(secret, encodedPayload);
  return `${encodedPayload}.${signature}`;
}

/** @returns {{ok: true, stripeCustomerId, email} | {ok: false, reason: string}} */
export function verifyMagicLinkToken(secret, token) {
  if (typeof token !== "string" || !token.includes(".")) {
    return { ok: false, reason: "malformed token" };
  }
  const [encodedPayload, signature] = token.split(".");
  const expected = sign(secret, encodedPayload);
  const sigBuf = Buffer.from(signature ?? "", "base64url");
  const expBuf = Buffer.from(expected, "base64url");
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return { ok: false, reason: "invalid signature" };
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed payload" };
  }
  if (typeof payload.exp !== "number" || Date.now() > payload.exp) {
    return { ok: false, reason: "token expired" };
  }
  return { ok: true, stripeCustomerId: payload.c, email: payload.e };
}
