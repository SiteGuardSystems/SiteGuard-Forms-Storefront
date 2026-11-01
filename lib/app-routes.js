// SiteGuard App billing on the storefront server: the founding offer
// (20 places, 12 months prepaid at 15% off, service from app go-live) and
// app subscriptions (trade packages, builder bundles, AUDIT seats).
//
// This is the reusable checkout engine the website (WP-S9/S10) calls; the
// interface is documented in docs/FOUNDING_OFFER.md. Every price is read from
// data/app-billing.json and the Stripe objects provisioned from it by
// scripts/sync-app-stripe.mjs -- never from the browser.
import { readFile, writeFile, stat, mkdir, rename } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import {
  validateAppBilling, getProduct, foundingAmountCents, pricesFor, matchingFormsPack, checkoutNotice,
  publicLineUp, serviceWindow, unusedPrepaymentCents, addMonths,
} from "./app-billing.js";
import { createFoundingLedger, todayIn } from "./founding-ledger.js";
import { makeOriginPolicy, appGates, makeLaunchCheck } from "./engine-origins.js";

const TRADE_RE = /^[A-Z]{2,6}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A YYYY-MM-DD date as a Unix timestamp at 00:00 AEST (UTC+10). */
export function dateToUnixAest(date) {
  const [y, m, d] = date.split("-").map(Number);
  return Math.floor((Date.UTC(y, m - 1, d) - 10 * 3_600_000) / 1000);
}

function clip(v, max) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function customFieldValue(session, key) {
  return session.custom_fields?.find((f) => f.key === key)?.text?.value ?? null;
}

export function registerAppBilling(app, {
  configPath,
  stripeMappingPath,
  varDir,
  stripe,
  stripeTestMode,
  stripeAutomaticTax = true,
  publicOrigin,
  allowedOrigins = [],
  // WP-S9: returnOrigin allowlist and source_site (lib/engine-origins.js).
  origins = makeOriginPolicy({ publicOrigin, systemsOrigins: allowedOrigins }),
  // WP-S10: data/site-mode.json app_status; see appGates.
  appStatus = "coming_soon",
  // WP-S10 / P7: async () => { live, ... } from GET /api/platform/launch.
  launchState = makeLaunchCheck({}),
  adminToken,
  loadCatalog,
  notifyOrderIntake,
  appendJsonLine,
  rateLimit,
  now = () => new Date(),
}) {
  // ---- config, re-read when the file changes (go-live moves are a config edit) ----
  let cfgCache = { mtimeMs: -1, cfg: null };
  let mapCache = { mtimeMs: -1, map: null };
  async function loadConfig() {
    const s = await stat(configPath);
    if (s.mtimeMs !== cfgCache.mtimeMs) {
      cfgCache = { mtimeMs: s.mtimeMs, cfg: validateAppBilling(JSON.parse(await readFile(configPath, "utf8"))) };
    }
    return cfgCache.cfg;
  }
  async function loadStripeMapping() {
    try {
      const s = await stat(stripeMappingPath);
      if (s.mtimeMs !== mapCache.mtimeMs) mapCache = { mtimeMs: s.mtimeMs, map: JSON.parse(await readFile(stripeMappingPath, "utf8")) };
      return mapCache.map;
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  const ledger = createFoundingLedger({
    file: path.join(varDir, "founding", "ledger.json"),
    getConfig: () => cfgCache.cfg,
    now,
  });
  const feedFile = path.join(varDir, "founding", "founding-feed.json");

  async function writeFeed() {
    const feed = await ledger.feed();
    await mkdir(path.dirname(feedFile), { recursive: true });
    const tmp = `${feedFile}.tmp`;
    await writeFile(tmp, JSON.stringify(feed, null, 2) + "\n", "utf8");
    await rename(tmp, feedFile);
    return feed;
  }

  // ---- delay credit: applied automatically whenever the configured go-live moves ----
  let appliedGoLive = null;
  let applying = null;
  async function ensureGoLiveApplied({ force = false } = {}) {
    const cfg = await loadConfig();
    if (!force && appliedGoLive === cfg.app_go_live_date) return [];
    if (applying) return applying;
    applying = (async () => {
      const changes = await ledger.applyGoLive(cfg.app_go_live_date);
      for (const c of changes) {
        let stripeResult = null;
        if (stripe && c.stripe_subscription_id) {
          try {
            await stripe.subscriptions.update(c.stripe_subscription_id, {
              trial_end: dateToUnixAest(c.service_end_date),
              proration_behavior: "none",
              metadata: { expected_start_date: c.expected_start_date, delay_credit_months: String(c.credit_months_total) },
            });
            stripeResult = "updated";
          } catch (err) {
            stripeResult = `failed: ${err.message}`;
          }
        }
        await appendJsonLine("founding-events.jsonl", { event: "delay_credit", ...c, stripe: stripeResult });
        if (c.credit_months_added > 0) {
          // Customer notice is a stub until the approved wording exists: logged, never sent.
          await appendJsonLine("mail-events.jsonl", { stub: true, label: "founding-delay-credit", sale_id: c.sale_id, note: "not sent: customer wording PENDING SOLICITOR" });
        }
      }
      appliedGoLive = cfg.app_go_live_date;
      if (changes.length) await writeFeed();
      return changes;
    })();
    try {
      return await applying;
    } finally {
      applying = null;
    }
  }

  function cors(req, res, next) {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") return res.status(origin && allowedOrigins.includes(origin) ? 204 : 403).end();
    next();
  }

  function requireAdmin(req, res, next) {
    if (!adminToken) return res.status(404).json({ ok: false, reason: "not found" });
    const given = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    const want = Buffer.from(adminToken);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return res.status(401).json({ ok: false, reason: "unauthorised" });
    next();
  }

  const limiter = rateLimit({ windowMs: 10 * 60_000, max: 20, message: "Too many checkout attempts. Wait a few minutes and try again." });

  /** Validates a product/trade/quantity request against config and catalogue. */
  async function resolveRequest(body, cfg) {
    const product = getProduct(cfg, body.productId);
    if (!product) return { error: [404, "unknown app product"] };
    const quantity = product.per === "seat" ? Number(body.quantity ?? 1) : 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > (product.max_quantity ?? 1)) {
      return { error: [400, `quantity must be 1 to ${product.max_quantity ?? 1}`] };
    }
    let trade = null;
    if (product.needs_trade) {
      trade = clip(body.trade, 8).toUpperCase();
      const catalogue = await loadCatalog();
      const known = (catalogue.trades ?? []).some((t) => t.code === trade);
      if (!TRADE_RE.test(trade) || !known) return { error: [400, "choose your trade"] };
    }
    return { product, quantity, trade };
  }

  function notice(cfg, kind) {
    return checkoutNotice(cfg, kind);
  }

  // ---------------- public routes ----------------

  app.options(["/api/founding/status", "/api/founding/places", "/api/founding/feed", "/api/founding/checkout", "/api/founding/checkout/cancel", "/api/app/prices", "/api/subscribe"], cors);

  app.get("/api/app/prices", cors, async (_req, res) => {
    const cfg = await loadConfig();
    const g = appGates(cfg, appStatus, now(), await launchState());
    res.json({
      ok: true,
      currency: cfg.currency,
      prices_exclude_gst: true,
      default_cadence: cfg.default_cadence,
      cadences: Object.fromEntries(Object.entries(cfg.cadences).map(([k, c]) => [k, { months: c.months, loading: c.loading, label: c.label }])),
      app_go_live_date: cfg.app_go_live_date,
      app_subscriptions_open: g.subscriptions.open,
      app_status: g.app_status,
      gate_disagreements: g.disagreements,
      // WP-S10: the subscription checkout notice and terms version the site must send back.
      notice: notice(cfg, "subscription"),
      products: publicLineUp(cfg),
    });
  });

  app.get("/api/founding/status", cors, async (_req, res) => {
    const cfg = await loadConfig();
    await ensureGoLiveApplied();
    const s = await ledger.status();
    const g = appGates(cfg, appStatus, now());
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      ...s,
      // WP-S10: open only when app_status is "presale" AND the ledger's window is open.
      open: s.open && g.founding.open,
      closed_reason: !g.founding.open ? g.founding.reason : s.closed_reason,
      app_status: g.app_status,
      gate_disagreements: g.disagreements,
      app_go_live_date: cfg.app_go_live_date,
      discount: cfg.founding.discount,
      term_months: cfg.founding.term_months,
      long_stop_date: cfg.founding.long_stop_date,
      notice: notice(cfg, "founding"),
    });
  });

  /** Places remaining, in the shape the FORMS site's app.js reads
   *  (data/site-mode.json founding_places_api = "/api/founding/places"). */
  app.get("/api/founding/places", cors, async (_req, res) => {
    const cfg = await loadConfig();
    await ensureGoLiveApplied();
    const s = await ledger.status();
    res.setHeader("Cache-Control", "no-store");
    res.json({ remaining: s.places_remaining, total: s.places_total, sold: s.places_sold, open: s.open && appGates(cfg, appStatus, now()).founding.open });
  });

  app.get("/api/founding/feed", cors, async (_req, res) => {
    await loadConfig();
    await ensureGoLiveApplied();
    res.setHeader("Cache-Control", "no-store");
    res.json(await writeFeed());
  });

  app.post("/api/founding/checkout", cors, limiter, async (req, res) => {
    const body = req.body ?? {};
    const cfg = await loadConfig();
    await ensureGoLiveApplied();
    const gate = appGates(cfg, appStatus, now()).founding;
    if (!gate.open) return res.status(409).json({ ok: false, reason: gate.reason, code: gate.code });
    const ret = origins.resolveReturn(req, body);
    if (ret.error) return res.status(ret.error[0]).json({ ok: false, reason: ret.error[1] });
    if (!stripe) return res.status(501).json({ ok: false, reason: "Checkout isn't available on this deployment." });
    const n = notice(cfg, "founding");
    if (body.acceptedTerms !== true) return res.status(400).json({ ok: false, reason: "Accept the founding offer terms to continue." });
    if (body.termsVersion !== n.terms_version) {
      return res.status(409).json({ ok: false, reason: "The terms have changed. Reload the page and accept the current terms.", terms_version: n.terms_version });
    }
    const r = await resolveRequest(body, cfg);
    if (r.error) return res.status(r.error[0]).json({ ok: false, reason: r.error[1] });
    const catalogue = await loadCatalog();
    const grant = matchingFormsPack(cfg, r.product.id, r.trade, catalogue);
    if (!grant) return res.status(409).json({ ok: false, reason: "There is no FORMS pack for that trade yet. Contact us." });
    const map = await loadStripeMapping();
    const prices = map?.byProductId?.[r.product.id]?.prices;
    if (!prices?.founding || !prices?.annual) return res.status(503).json({ ok: false, reason: "Founding checkout isn't set up on this deployment yet." });
    const email = clip(body.email, 200);

    const held = await ledger.reserve({ productId: r.product.id, trade: r.trade, quantity: r.quantity, minutes: cfg.founding.reservation_minutes });
    if (!held.ok) return res.status(409).json({ ok: false, reason: held.reason, places_remaining: held.status.places_remaining });
    const reservation = held.reservation;
    const expected = cfg.app_go_live_date;
    const listCents = Math.round(r.product.monthly_aud * 100 * cfg.founding.term_months) * r.quantity;
    const foundingCents = foundingAmountCents(cfg, r.product) * r.quantity;
    const metadata = {
      kind: "founding",
      reservation_id: reservation.id,
      app_product_id: r.product.id,
      trade: r.trade ?? "",
      quantity: String(r.quantity),
      expected_start_date: expected,
      term_months: String(cfg.founding.term_months),
      list_price_cents_ex_gst: String(listCents),
      founding_price_cents_ex_gst: String(foundingCents),
      discount: String(cfg.founding.discount),
      forms_pack_id: grant.packId,
      terms_version: n.terms_version,
      price_rise_clause_version: n.price_rise_clause_version,
      notice_status: n.status,
      source_site: ret.site,
      return_origin: ret.origin,
    };
    try {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        client_reference_id: reservation.id,
        customer_creation: "always",
        ...(EMAIL_RE.test(email) ? { customer_email: email } : {}),
        billing_address_collection: "required",
        ...(stripeAutomaticTax ? { automatic_tax: { enabled: true }, tax_id_collection: { enabled: true } } : {}),
        line_items: [{ price: prices.founding, quantity: r.quantity }],
        // Card only: the same card renews the plan after the founding year.
        payment_method_types: ["card"],
        // Saved for the renewal after the founding year (standard price, with a reminder first).
        payment_intent_data: { setup_future_usage: "off_session", metadata, description: `Founding place: ${r.product.name}` },
        custom_fields: [
          { key: "client_name", label: { type: "custom", custom: "Business name (printed on your FORMS pack)" }, type: "text", text: { minimum_length: 1, maximum_length: 200 } },
          { key: "project_address", label: { type: "custom", custom: "Business address" }, type: "text", text: { minimum_length: 1, maximum_length: 255 } },
        ],
        custom_text: { submit: { message: n.text } },
        expires_at: Math.floor(now().getTime() / 1000) + cfg.founding.checkout_session_minutes * 60,
        metadata,
        success_url: `${ret.origin}/founding/success/?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${ret.origin}/founding/cancelled/?session_id={CHECKOUT_SESSION_ID}`,
      });
      await ledger.attachSession(reservation.id, session.id);
      await appendJsonLine("founding-events.jsonl", { event: "reserved", reservation_id: reservation.id, session_id: session.id, product: r.product.id, trade: r.trade });
      res.json({ ok: true, url: session.url, session_id: session.id, reservation_expires_at: reservation.expires_at, places_remaining: held.status.places_remaining });
    } catch (err) {
      await ledger.release({ reservationId: reservation.id, reason: "stripe_error" });
      console.error("Founding checkout session creation failed", err);
      res.status(502).json({ ok: false, reason: "Checkout is temporarily unavailable. Please try again shortly." });
    }
  });

  /** The cancel page calls this so the place goes back at once rather than at expiry. */
  app.post("/api/founding/checkout/cancel", cors, limiter, async (req, res) => {
    const sessionId = clip(req.body?.session_id, 255);
    if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) return res.status(400).json({ ok: false, reason: "session_id required" });
    await loadConfig();
    if (stripe) {
      try {
        const s = await stripe.checkout.sessions.retrieve(sessionId);
        if (s.metadata?.kind !== "founding") return res.status(404).json({ ok: false, reason: "not found" });
        if (s.status === "open") await stripe.checkout.sessions.expire(sessionId);
        else if (s.status === "complete") return res.json({ ok: true, released: false, reason: "already paid" });
      } catch (err) {
        return res.status(502).json({ ok: false, reason: "Could not reach Stripe. The place is released automatically when the checkout expires." });
      }
    }
    const r = await ledger.release({ sessionId, reason: "cancelled" });
    res.json({ ok: true, released: r.released });
  });

  /** App subscriptions (not founding). Closed until the app goes live and
   *  app_subscriptions_open is set. WP-S9/S10 calls this from the website. */
  app.post("/api/subscribe", cors, limiter, async (req, res) => {
    const body = req.body ?? {};
    const cfg = await loadConfig();
    // WP-S10: app_status "live" AND P2's gate (app_subscriptions_open, go-live date).
    const gate = appGates(cfg, appStatus, now(), await launchState()).subscriptions;
    if (!gate.open) return res.status(409).json({ ok: false, reason: gate.reason, code: gate.code });
    const ret = origins.resolveReturn(req, body);
    if (ret.error) return res.status(ret.error[0]).json({ ok: false, reason: ret.error[1] });
    if (!stripe) return res.status(501).json({ ok: false, reason: "Checkout isn't available on this deployment." });
    const n = notice(cfg, "subscription");
    if (body.acceptedTerms !== true) return res.status(400).json({ ok: false, reason: "Accept the terms to continue." });
    if (body.termsVersion !== n.terms_version) return res.status(409).json({ ok: false, reason: "The terms have changed. Reload the page.", terms_version: n.terms_version });
    const cadence = body.cadence ?? cfg.default_cadence;
    if (!cfg.cadences[cadence]) return res.status(400).json({ ok: false, reason: "unknown billing cadence" });
    const r = await resolveRequest(body, cfg);
    if (r.error) return res.status(r.error[0]).json({ ok: false, reason: r.error[1] });
    const map = await loadStripeMapping();
    const priceId = map?.byProductId?.[r.product.id]?.prices?.[cadence];
    if (!priceId) return res.status(503).json({ ok: false, reason: "Subscriptions aren't set up on this deployment yet." });
    const metadata = {
      kind: "app_subscription", app_product_id: r.product.id, trade: r.trade ?? "", quantity: String(r.quantity), cadence,
      period_amount_cents_ex_gst: String(pricesFor(cfg, r.product)[cadence] * r.quantity),
      terms_version: n.terms_version, price_rise_clause_version: n.price_rise_clause_version, notice_status: n.status,
      source_site: ret.site, return_origin: ret.origin,
    };
    try {
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        billing_address_collection: "required",
        ...(stripeAutomaticTax ? { automatic_tax: { enabled: true }, tax_id_collection: { enabled: true } } : {}),
        line_items: [{ price: priceId, quantity: r.quantity }],
        subscription_data: { metadata },
        custom_fields: [
          { key: "client_name", label: { type: "custom", custom: "Business name" }, type: "text", text: { minimum_length: 1, maximum_length: 200 } },
        ],
        custom_text: { submit: { message: n.text } },
        metadata,
        success_url: `${ret.origin}/app/success/`,
        cancel_url: `${ret.origin}/app/cancelled/`,
      });
      res.json({ ok: true, url: session.url, session_id: session.id });
    } catch (err) {
      console.error("App subscription checkout failed", err);
      res.status(502).json({ ok: false, reason: "Checkout is temporarily unavailable. Please try again shortly." });
    }
  });

  // ---------------- admin (Bearer FOUNDING_ADMIN_TOKEN; 404 when unset) ----------------

  /** Every founding sale record: the P7 founding import reads this. */
  app.get("/api/founding/admin/sales", requireAdmin, async (_req, res) => {
    await loadConfig();
    await ensureGoLiveApplied();
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, sales: await ledger.sales(), status: await ledger.status() });
  });

  /** Re-applies the configured go-live to every sale (normally automatic). */
  app.post("/api/founding/admin/apply-go-live", requireAdmin, async (_req, res) => {
    const changes = await ensureGoLiveApplied({ force: true });
    res.json({ ok: true, changes });
  });

  /** Refund of the unused prepayment, on the customer's request. */
  app.post("/api/founding/admin/refund", requireAdmin, async (req, res) => {
    const cfg = await loadConfig();
    const saleId = clip(req.body?.sale_id, 64);
    const reason = clip(req.body?.reason, 500) || "customer request";
    if (!stripe) return res.status(501).json({ ok: false, reason: "Stripe not configured" });
    const today = todayIn(now());
    let result = null;
    const sale = await ledger.updateSale(saleId, async (s) => {
      const amount = unusedPrepaymentCents(cfg, s, today);
      if (amount <= 0) {
        result = { ok: false, status: 409, reason: "Nothing left to refund on this sale." };
        return;
      }
      const refund = await stripe.refunds.create({
        payment_intent: s.stripe_payment_intent_id,
        amount,
        reason: "requested_by_customer",
        metadata: { founding_sale_id: s.sale_id, kind: "unused_prepayment" },
      });
      s.refunds.push({ kind: "unused_prepayment", amount_cents: amount, stripe_refund_id: refund.id, stripe_status: refund.status, reason, at: now().toISOString(), as_of: today });
      const refunded = s.refunds.reduce((t, r) => t + r.amount_cents, 0);
      s.status = refunded >= s.amount_paid_total_cents ? "refunded" : "partially_refunded";
      if (s.stripe_subscription_id) {
        try {
          await stripe.subscriptions.cancel(s.stripe_subscription_id);
          s.renewal_cancelled_at = now().toISOString();
        } catch (err) {
          s.renewal_cancel_error = err.message;
        }
      }
      result = { ok: true, refund: { id: refund.id, amount_cents: amount, status: refund.status } };
    });
    if (!sale) return res.status(404).json({ ok: false, reason: "no such sale" });
    if (!result.ok) return res.status(result.status).json(result);
    await appendJsonLine("founding-events.jsonl", { event: "refund", sale_id: sale.sale_id, ...result.refund });
    await appendJsonLine("mail-events.jsonl", { stub: true, label: "founding-refund", sale_id: sale.sale_id, note: "not sent: customer wording PENDING SOLICITOR" });
    await writeFeed();
    res.json({ ...result, sale });
  });

  // ---------------- webhook ----------------

  async function fulfilFounding(session) {
    const cfg = await loadConfig();
    const md = session.metadata ?? {};
    const pi = typeof session.payment_intent === "string"
      ? await stripe.paymentIntents.retrieve(session.payment_intent)
      : session.payment_intent;
    const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
    const paidAt = new Date((session.created ?? Math.floor(now().getTime() / 1000)) * 1000);
    const product = getProduct(cfg, md.app_product_id);
    const quantity = Number(md.quantity || 1);
    const startDate = md.expected_start_date || cfg.app_go_live_date;
    const { sale, created } = await ledger.confirmSale({
      reservationId: md.reservation_id,
      sessionId: session.id,
      build: ({ saleId, oversold }) => ({
        sale_id: saleId,
        status: "active",
        oversold,
        stripe_session_id: session.id,
        stripe_customer_id: customerId,
        stripe_payment_intent_id: pi?.id ?? null,
        stripe_subscription_id: null,
        app_product_id: md.app_product_id,
        app_product_name: product?.name ?? md.app_product_id,
        trade: md.trade || null,
        quantity,
        currency: session.currency,
        list_price_cents_ex_gst: Number(md.list_price_cents_ex_gst),
        discount: Number(md.discount),
        price_paid_cents_ex_gst: (session.amount_subtotal ?? 0) - (session.total_details?.amount_discount ?? 0),
        gst_cents: session.total_details?.amount_tax ?? 0,
        amount_paid_total_cents: session.amount_total,
        paid_at: paidAt.toISOString(),
        original_expected_start_date: startDate,
        expected_start_date: startDate,
        term_months: cfg.founding.term_months,
        service_end_date: serviceWindow(cfg, startDate, 0).end,
        terms_version: md.terms_version,
        price_rise_clause_version: md.price_rise_clause_version,
        notice_status: md.notice_status,
        forms_pack: { pack_id: md.forms_pack_id, granted_at: null, intake: null },
        delay_credits: [],
        refunds: [],
        long_stop_passed: false,
        customer: {
          email: session.customer_details?.email ?? null,
          business_name: customFieldValue(session, "client_name"),
          address: customFieldValue(session, "project_address"),
        },
      }),
    });

    // Renewal after the founding year: a subscription at the STANDARD annual
    // price whose trial covers the prepaid term (and any delay credit). Stripe
    // then renews at the standard price, and the delay credit moves its trial end.
    if (cfg.founding.create_renewal_subscription && !sale.stripe_subscription_id && customerId) {
      const map = await loadStripeMapping();
      const annual = map?.byProductId?.[sale.app_product_id]?.prices?.annual;
      const pm = typeof pi?.payment_method === "string" ? pi.payment_method : pi?.payment_method?.id;
      if (annual) {
        const sub = await stripe.subscriptions.create({
          customer: customerId,
          items: [{ price: annual, quantity }],
          trial_end: dateToUnixAest(sale.service_end_date),
          ...(pm ? { default_payment_method: pm } : {}),
          proration_behavior: "none",
          ...(stripeAutomaticTax ? { automatic_tax: { enabled: true } } : {}),
          trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
          metadata: { kind: "founding_renewal", founding_sale_id: sale.sale_id, expected_start_date: sale.expected_start_date, delay_credit_months: "0" },
        }, { idempotencyKey: `founding-renewal-${session.id}` });
        await ledger.updateSale(sale.sale_id, (s) => { s.stripe_subscription_id = sub.id; s.renewal_status = sub.status; });
        sale.stripe_subscription_id = sub.id;
      }
    }

    // The matching FORMS pack, free from purchase: recorded in FORMS through
    // the same storefront-orders intake as a paid pack, at A$0, option "founding-grant".
    if (!sale.forms_pack.granted_at) {
      const ok = await notifyOrderIntake({
        packageId: sale.forms_pack.pack_id,
        packageName: `Founding grant: ${sale.forms_pack.pack_id}`,
        option: "founding-grant",
        stripeSessionId: `${session.id}:founding-grant`,
        customerEmail: sale.customer.email,
        projectAddress: sale.customer.address,
        clientName: sale.customer.business_name,
        amountTotal: 0,
        currency: session.currency ?? undefined,
      });
      await ledger.updateSale(sale.sale_id, (s) => {
        s.forms_pack.intake = ok === null ? "not_configured" : ok ? "recorded" : "failed";
        if (ok !== false) s.forms_pack.granted_at = now().toISOString();
      });
      if (ok === false) throw new Error("FORMS intake failed for the founding grant");
    }
    if (created) {
      await appendJsonLine("founding-events.jsonl", { event: "sold", sale_id: sale.sale_id, session_id: session.id, oversold: sale.oversold });
      await appendJsonLine("mail-events.jsonl", { stub: true, label: "founding-confirmation", to: sale.customer.email, sale_id: sale.sale_id, note: "not sent: customer wording PENDING SOLICITOR" });
    }
    await writeFeed();
    return sale;
  }

  /** Handles checkout events for app billing. Returns null when the event
   *  isn't ours (the FORMS one-off flow handles it), else { status, body }. */
  async function handleEvent(event) {
    const session = event.data?.object;
    const kind = session?.metadata?.kind;
    if (kind !== "founding" && kind !== "app_subscription") return null;
    await loadConfig();
    if (event.type === "checkout.session.expired") {
      if (kind === "founding") {
        const r = await ledger.release({ reservationId: session.metadata.reservation_id, sessionId: session.id, reason: "expired" });
        await appendJsonLine("founding-events.jsonl", { event: "released", session_id: session.id, released: r.released });
      }
      return { status: 200, body: { received: true } };
    }
    if (event.type === "checkout.session.async_payment_failed" && kind === "founding") {
      await ledger.release({ reservationId: session.metadata.reservation_id, sessionId: session.id, reason: "payment_failed" });
      return { status: 200, body: { received: true } };
    }
    if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") {
      return { status: 200, body: { received: true } };
    }
    if (session.payment_status !== "paid") {
      await appendJsonLine("orders-awaiting-payment.jsonl", { sessionId: session.id, eventId: event.id, kind, paymentStatus: session.payment_status ?? null });
      return { status: 200, body: { received: true, awaitingPayment: true } };
    }
    try {
      if (kind === "founding") {
        const sale = await fulfilFounding(session);
        return { status: 200, body: { received: true, founding_sale_id: sale.sale_id } };
      }
      // WP-S10: recorded and logged for Dan. No email is sent (customer wording
      // is PENDING SOLICITOR); the P7 app entitlement import reads this file.
      console.log(`App subscription for Dan: ${session.metadata?.app_product_id} x${session.metadata?.quantity ?? 1} (${session.metadata?.cadence}) from ${session.metadata?.source_site ?? "forms"}, session ${session.id}`);
      await appendJsonLine("app-subscriptions.jsonl", {
        event: "subscribed", for_dan: true, session_id: session.id, subscription: session.subscription ?? null, customer: session.customer ?? null,
        email: session.customer_details?.email ?? null, ...session.metadata,
        amount_total_cents: session.amount_total, gst_cents: session.total_details?.amount_tax ?? null,
      });
      return { status: 200, body: { received: true } };
    } catch (err) {
      console.error("App billing fulfilment failed; Stripe will retry", session.id, err);
      return { status: 500, body: { received: false } };
    }
  }

  return { handleEvent, ensureGoLiveApplied, ledger, loadConfig, writeFeed, addMonths };
}
