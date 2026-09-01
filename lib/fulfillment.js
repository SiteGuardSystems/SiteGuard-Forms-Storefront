// The one door between the storefront and the Artifact Factory.
//
// The storefront holds customer money and customer personal data; the factory
// holds the document library, SharePoint credentials and the ops database.
// README.md keeps them apart on purpose. This module is the single exception,
// and it is deliberately narrow: one POST, one shared key, one shape. No
// database handle, no Graph token, nothing the factory can call back into.
//
// **It hands over an intake, not a job.** The factory records the request as
// RECEIVED and it stays inert until a person moves it through review. Selling
// a document and manufacturing one are separate decisions and this only
// automates the first.
//
// **It never throws into the redemption path.** By the time this runs the
// customer's credit is already spent, so a factory outage must not turn into a
// failed redemption — they would lose a credit and get an error. Every failure
// comes back as a value, gets written to the redemptions log, and can be
// replayed later against the same `sourceRedemptionId`, which the factory
// deduplicates on.

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * @param {object} opts
 * @param {string} [opts.baseUrl]  factory API origin, e.g. http://127.0.0.1:3001
 * @param {string} [opts.apiKey]   shared secret, matches STOREFRONT_API_KEY there
 * @param {number} [opts.timeoutMs]
 * @param {typeof fetch} [opts.fetchImpl] injected in tests
 */
export function createFulfillmentClient({
  baseUrl,
  apiKey,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const enabled = Boolean(baseUrl && apiKey);

  return {
    enabled,

    /**
     * Hand a redeemed project to the factory.
     *
     * Always resolves. `{ ok: true, id }` when the factory took it,
     * `{ ok: false, reason, status? }` otherwise — including when this is not
     * configured at all, which is the state on a box that has a storefront and
     * no factory.
     */
    async submit({
      sourceRedemptionId,
      packageId,
      stripeCustomerId,
      customerEmail,
      projectAddress,
      clientName,
      siteNotes,
    }) {
      if (!enabled) {
        return { ok: false, reason: "not-configured" };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/api/storefront-fulfillment`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-storefront-api-key": apiKey,
          },
          body: JSON.stringify({
            sourceRedemptionId,
            packageId,
            stripeCustomerId,
            customerEmail,
            projectAddress,
            clientName,
            ...(siteNotes ? { siteNotes } : {}),
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          // The body may be JSON or may be an nginx error page. Either way the
          // status is what a replay needs, and a truncated body is enough to
          // recognise the failure by eye in the log.
          let detail = "";
          try {
            detail = (await res.text()).slice(0, 300);
          } catch {
            detail = "";
          }
          return { ok: false, reason: "rejected", status: res.status, detail };
        }

        const body = await res.json();
        return { ok: true, id: body.id, deduplicated: Boolean(body.deduplicated) };
      } catch (err) {
        // AbortError included: a timeout is a transport failure like any other
        // and the request is still safe in the redemptions log.
        return {
          ok: false,
          reason: err?.name === "AbortError" ? "timeout" : "unreachable",
          detail: String(err?.message ?? err).slice(0, 300),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
