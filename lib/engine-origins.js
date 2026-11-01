// The one checkout engine for both SiteGuard websites (WP-S9 / WP-S10).
//
// siteguardforms.com.au calls the engine same-origin; siteguardsystems.com.au
// calls it cross-origin. This module holds the three rules every checkout
// route shares:
//
//   origins   which sites may call the checkout routes (CORS), which origins a
//             buyer may be sent back to after Stripe (the returnOrigin
//             allowlist), and which site a sale came from (source_site, put in
//             the Stripe metadata of every session)
//   gates     whether founding places and app subscriptions can be sold: the
//             site's app_status (data/site-mode.json, the same field and values
//             as siteguard-website) AND P2's own date/config gates
//             (data/app-billing.json) AND, for subscriptions, the platform's
//             launch endpoint (P7: AUDIT API GET /api/platform/launch) must all
//             say yes
//   routing   which flow a paid Checkout Session belongs to, from its session
//             metadata and its line-item metadata
import { todayIn } from "./founding-ledger.js";

export const SOURCE_SITES = ["forms", "systems"];
export const APP_STATUSES = ["coming_soon", "presale", "live"];

const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/;

/**
 * publicOrigin: the storefront itself (source_site "forms").
 * systemsOrigins: siteguardsystems.com.au and its www form (source_site
 * "systems"); LEAD_ALLOWED_ORIGINS by default, the same list /api/lead and
 * P2's app routes already use.
 */
export function makeOriginPolicy({ publicOrigin, systemsOrigins = [] }) {
  const own = String(publicOrigin ?? "").replace(/\/$/, "");
  const systems = systemsOrigins.map((o) => String(o).replace(/\/$/, "")).filter((o) => ORIGIN_RE.test(o));

  /** The site an origin belongs to, or null when it isn't allowed. */
  function siteOf(origin) {
    if (!origin) return null;
    if (origin === own) return "forms";
    if (systems.includes(origin)) return "systems";
    return null;
  }

  /**
   * Where Stripe sends the buyer back to. Rules:
   *  - a cross-origin request must come from an allowed origin (else 403);
   *  - returnOrigin, when given, must be on the allowlist (else 400) and, on a
   *    cross-origin request, equal the request's Origin (else 400): a site can
   *    only bring its own buyers home;
   *  - with no returnOrigin, the request's allowed Origin, else the storefront.
   * source_site follows the return origin; a body's own source_site must agree.
   */
  function resolveReturn(req, body = {}) {
    const origin = req.headers.origin;
    // Same-origin: the storefront's own pages (browsers send Origin on a
    // same-origin POST too, and the host may differ from publicOrigin behind a
    // proxy or on a review copy).
    let sameHost = false;
    try { sameHost = Boolean(origin) && new URL(origin).host === req.headers.host; } catch { sameHost = false; }
    const crossSite = origin && origin !== own && !sameHost;
    if (crossSite && !siteOf(origin)) return { error: [403, "This site can't start a checkout here."] };
    let ret = own;
    if (body.returnOrigin !== undefined && body.returnOrigin !== null && body.returnOrigin !== "") {
      const r = String(body.returnOrigin).replace(/\/$/, "");
      if (!ORIGIN_RE.test(r) || !siteOf(r)) return { error: [400, "returnOrigin isn't an allowed site"] };
      if (crossSite && r !== origin) return { error: [400, "returnOrigin must be the site the checkout started on"] };
      ret = r;
    } else if (crossSite) {
      ret = origin;
    }
    const site = siteOf(ret);
    if (body.source_site !== undefined && body.source_site !== site) return { error: [400, `source_site must be "${site}" for ${ret}`] };
    return { origin: ret, site };
  }

  /** CORS for the checkout routes: allowed origins only; a disallowed
   *  preflight gets 403. */
  function cors(methods = "POST, OPTIONS") {
    return function checkoutCors(req, res, next) {
      const origin = req.headers.origin;
      const ok = origin && systems.includes(origin);
      if (ok) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Methods", methods);
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Access-Control-Max-Age", "600");
      }
      if (req.method === "OPTIONS") return res.status(ok ? 204 : 403).end();
      next();
    };
  }

  return { siteOf, resolveReturn, cors, returnOrigins: [own, ...systems] };
}

/**
 * Founding places and app subscriptions: the site's app_status and P2's
 * app-billing.json gates must agree.
 *
 *   founding       app_status "presale" here, AND the founding ledger's own
 *                  window (sale_opens_at .. sale_closes_at / go-live) and stock
 *   subscriptions  app_status "live" here, AND app_subscriptions_open AND
 *                  today >= app_go_live_date (P2)
 *
 * Either side alone can close a sale; neither alone can open one. Where the
 * two disagree (one says open, the other closed) the sale stays closed and the
 * disagreement is listed, so /api/founding/status, /api/app/prices and the
 * server's start-up log show Dan what to switch.
 */
/**
 * P7's single "is the app live" source: the AUDIT API's public
 * GET /api/platform/launch -> { appGoLive, goLiveDate, plannedGoLiveDate,
 * pricingRevision }. Live only on HTTP 200 within 5 s with appGoLive === true;
 * the answer is cached for at most 5 minutes. No URL configured, a timeout,
 * an error or any other answer counts as not live.
 */
export function makeLaunchCheck({ url, fetchImpl = fetch, nowMs = () => Date.now(), ttlMs = 5 * 60_000, timeoutMs = 5000 } = {}) {
  let cache = null;
  return async function launchState() {
    if (!url) return { live: false, reason: "no launch endpoint configured (APP_LAUNCH_URL)" };
    if (cache && nowMs() - cache.at < ttlMs) return cache.state;
    let state;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      let r;
      try { r = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: ctrl.signal }); } finally { clearTimeout(t); }
      const j = r.status === 200 ? await r.json() : null;
      state = j && j.appGoLive === true
        ? { live: true, goLiveDate: j.goLiveDate ?? null, plannedGoLiveDate: j.plannedGoLiveDate ?? null, pricingRevision: j.pricingRevision ?? null }
        : { live: false, reason: r.status === 200 ? "the platform says the app isn't live" : `launch endpoint answered ${r.status}` };
    } catch (e) {
      state = { live: false, reason: `launch endpoint unreachable (${e.name === "AbortError" ? "timeout" : e.message})` };
    }
    cache = { at: nowMs(), state };
    return state;
  };
}

export function appGates(cfg, appStatus, now = new Date(), launch = { live: false }) {
  const today = todayIn(now);
  const status = APP_STATUSES.includes(appStatus) ? appStatus : "coming_soon";
  const f = cfg.founding ?? {};
  const closesAt = f.sale_closes_at ?? cfg.app_go_live_date;
  const foundingWindow = f.enabled !== false && today >= f.sale_opens_at && today < closesAt;
  // app_subscriptions_open is kept as an extra off-switch (Dan can close
  // subscriptions in config without touching the platform or the site).
  const subsConfig = Boolean(cfg.app_subscriptions_open) && today >= cfg.app_go_live_date;
  const launchLive = launch?.live === true;
  const disagreements = [];
  if (status === "presale" && !foundingWindow) disagreements.push(`app_status is "presale" but app-billing.json's founding window is closed today (${f.sale_opens_at} to ${closesAt})`);
  if (status !== "presale" && foundingWindow) disagreements.push(`app-billing.json's founding window is open today but app_status is "${status}"`);
  if (status === "live" && !subsConfig) disagreements.push(`app_status is "live" but app-billing.json has app subscriptions closed (app_subscriptions_open ${Boolean(cfg.app_subscriptions_open)}, go-live ${cfg.app_go_live_date})`);
  if (status !== "live" && subsConfig) disagreements.push(`app-billing.json has app subscriptions open but app_status is "${status}"`);
  if (status === "live" && !launchLive) disagreements.push(`app_status is "live" but the platform launch endpoint doesn't say appGoLive (${launch?.reason ?? "not live"})`);
  if (status !== "live" && launchLive) disagreements.push(`the platform launch endpoint says appGoLive but app_status is "${status}"`);
  return {
    app_status: status,
    founding: status === "presale"
      ? { open: true, reason: null }
      : { open: false, reason: "Founding places aren't on sale right now.", code: "FOUNDING_NOT_OPEN" },
    subscriptions: status === "live" && subsConfig && launchLive
      ? { open: true, reason: null }
      : { open: false, reason: `The SiteGuard App opens on ${cfg.app_go_live_date}.`, code: "APP_NOT_OPEN" },
    disagreements,
  };
}

/**
 * Which flow a Checkout Session belongs to. Session metadata decides first
 * (kind: founding / app_subscription, set by P2's routes); line-item product
 * metadata confirms it (packageId and documentCode for FORMS one-offs,
 * app_product_id / appPlan for app plans, founding for founding places).
 * A session whose lines disagree with its kind, or that mixes FORMS and app
 * lines, is "mixed": it is recorded for Dan and not fulfilled.
 */
export function classifySession(session, lineItems = null) {
  const kind = session?.metadata?.kind;
  const lines = lineItems ?? session?.line_items?.data ?? [];
  const lineKinds = new Set(lines.map((li) => {
    const md = { ...(li.price?.metadata ?? {}), ...(li.price?.product?.metadata ?? {}) };
    if (md.founding === "true" || md.cadence === "founding") return "founding";
    if (md.appPlan || md.app_product_id) return "app";
    if (md.packageId || md.documentCode) return "forms";
    return null;
  }).filter(Boolean));
  const fromKind = kind === "founding" ? "founding" : kind === "app_subscription" ? "app_subscription" : null;
  if (lineKinds.has("forms") && (lineKinds.has("app") || lineKinds.has("founding") || fromKind)) return "mixed";
  if (fromKind === "founding" && lineKinds.has("app") && !lineKinds.has("founding")) return fromKind; // renewal price ids carry no founding flag
  if (fromKind) return fromKind;
  if (lineKinds.has("founding")) return "founding";
  if (lineKinds.has("app")) return "app_subscription";
  return "forms";
}
