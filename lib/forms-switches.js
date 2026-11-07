// The FORMS go-live switches (go-live brief Rev02, Section 2: S1 sales_open,
// S2 delivery_mode, S3 delivery_sla_business_days, S4 subscriptions_open,
// S5 consultant_plans_open). SiteGuard-Forms holds them and enforces them
// itself; the storefront reads them from GET /api/v3/storefront/switches with
// the same storefront intake key it already sends to POST
// /api/v3/storefront-orders (header x-storefront-api-key).
//
// Fail closed: no URL or key, a timeout, a non-200 answer or a malformed body
// all mean "everything off" (no checkout, subscriptions and consultant plans
// hidden, the SLA text falls back to 3). Nothing here can open anything that
// FORMS hasn't said is open.

export const CLOSED = Object.freeze({
  sales_open: false,
  delivery_mode: "manual",
  delivery_sla_business_days: 3,
  subscriptions_open: false,
  consultant_plans_open: false,
  read_ok: false,
});

/** The switches endpoint beside the order intake URL (same FORMS host). */
export function switchesUrlFrom(orderIntakeUrl) {
  if (!orderIntakeUrl) return null;
  try {
    return new URL("/api/v3/storefront/switches", orderIntakeUrl).toString();
  } catch {
    return null;
  }
}

/** Checks FORMS' answer field by field; anything off-shape is CLOSED. */
export function normaliseSwitches(body) {
  if (!body || typeof body !== "object") return CLOSED;
  const bool = (v) => v === true;
  const sla = Number.isInteger(body.delivery_sla_business_days) && body.delivery_sla_business_days >= 1 && body.delivery_sla_business_days <= 10
    ? body.delivery_sla_business_days : 3;
  if (typeof body.sales_open !== "boolean" || typeof body.subscriptions_open !== "boolean" || typeof body.consultant_plans_open !== "boolean") return CLOSED;
  return Object.freeze({
    sales_open: bool(body.sales_open),
    delivery_mode: body.delivery_mode === "auto" ? "auto" : "manual",
    delivery_sla_business_days: sla,
    subscriptions_open: bool(body.subscriptions_open),
    consultant_plans_open: bool(body.consultant_plans_open),
    read_ok: true,
  });
}

/**
 * An async reader for the switches, cached for `ttlMs` (a switch Dan flips in
 * the Console shows here within that time). Never throws.
 */
export function makeSwitchReader({ url, apiKey, fetchImpl = fetch, ttlMs = 15_000, timeoutMs = 4_000, now = () => Date.now() } = {}) {
  let cache = null;
  return async function readSwitches() {
    if (!url || !apiKey) return CLOSED;
    if (cache && now() - cache.at < ttlMs) return cache.value;
    let value = CLOSED;
    try {
      const res = await fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json", "x-storefront-api-key": apiKey },
        signal: AbortSignal.timeout(timeoutMs),
      });
      value = res.ok ? normaliseSwitches(await res.json().catch(() => null)) : CLOSED;
    } catch {
      value = CLOSED;
    }
    cache = { at: now(), value };
    return value;
  };
}
