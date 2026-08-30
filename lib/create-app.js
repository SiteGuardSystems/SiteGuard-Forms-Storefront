// The Express app itself, as a pure factory with no side effects (no env
// reads, no listen()) — so tests can build one against a temp catalog/var
// dir and a fake Stripe client, and server.js can build the real one.
import { readFile, appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import express from "express";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_SHORT_FIELD = 200;
const MAX_LONG_FIELD = 2000;

function clip(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * Catalog shape: `categories[]`, each with `items[]` and an optional
 * `_itemDefaults` applied to every item in that category (used by the SWMS
 * category, where 21 trades share the same coming-soon treatment instead of
 * repeating four fields 21 times). Flattening resolves defaults once and
 * gives checkout a flat id -> item lookup regardless of category nesting.
 */
function flattenCatalog(catalog) {
  const items = [];
  for (const category of catalog.categories ?? []) {
    const defaults = category._itemDefaults ?? {};
    for (const item of category.items ?? []) {
      items.push({ ...defaults, ...item, categoryId: category.id });
    }
  }
  return items;
}

/** Basic hardening headers. No CSP here yet — the page loads Google Fonts,
 *  and a CSP that's wrong is worse than none (silently breaks the page). */
function securityHeaders(_req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
}

export function createApp({
  catalogPath,
  varDir,
  publicDir,
  stripe,
  stripeTestMode,
  stripeWebhookSecret,
  publicOrigin,
}) {
  async function loadCatalog() {
    const raw = await readFile(catalogPath, "utf8");
    return JSON.parse(raw);
  }

  async function appendJsonLine(file, record) {
    await mkdir(varDir, { recursive: true });
    await appendFile(
      path.join(varDir, file),
      JSON.stringify({ ...record, at: new Date().toISOString() }) + "\n",
      "utf8",
    );
  }

  const app = express();
  app.use(securityHeaders);

  // Stripe webhook needs the raw body for signature verification — must be
  // registered before express.json() touches the request.
  app.post(
    "/api/webhook/stripe",
    express.raw({ type: "application/json" }),
    async (req, res) => {
      if (!stripe || !stripeWebhookSecret) {
        return res.status(501).json({ ok: false, reason: "Stripe not configured" });
      }
      let event;
      try {
        event = stripe.webhooks.constructEvent(
          req.body,
          req.headers["stripe-signature"],
          stripeWebhookSecret,
        );
      } catch (err) {
        return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
      }

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        await appendJsonLine("orders.jsonl", {
          event: "checkout.session.completed",
          sessionId: session.id,
          packageId: session.metadata?.packageId ?? null,
          customerEmail: session.customer_details?.email ?? null,
          amountTotal: session.amount_total,
          currency: session.currency,
        });
        // TODO(fulfillment): extension point for actually delivering the
        // purchased document(s). Deliberately not built yet: needs a
        // decision on delivery mechanism, and confirmation the specific
        // document is QA-clean before being handed to a paying customer —
        // the library is still being developed/hardened as of 2026-08-30,
        // not yet approved to reach real clients.
      }

      res.json({ received: true });
    },
  );

  app.use(express.json());
  if (publicDir) {
    app.use(express.static(publicDir));
  }

  app.get("/api/packages", async (_req, res) => {
    const catalog = await loadCatalog();
    res.json({ ...catalog, stripeConfigured: Boolean(stripe), stripeTestMode });
  });

  app.post("/api/checkout", async (req, res) => {
    const { packageId } = req.body ?? {};
    if (!packageId || typeof packageId !== "string") {
      return res.status(400).json({ ok: false, reason: "packageId is required" });
    }
    const catalog = await loadCatalog();
    const item = flattenCatalog(catalog).find((i) => i.id === packageId);
    if (!item) {
      return res.status(404).json({ ok: false, reason: "unknown packageId" });
    }
    if (item.tier === "quote") {
      return res
        .status(409)
        .json({ ok: false, reason: "This package is quote-based — submit the enquiry form instead." });
    }
    if (item.tier === "coming-soon") {
      return res
        .status(409)
        .json({ ok: false, reason: "This item isn't available for purchase yet — register interest instead." });
    }
    if (!stripe) {
      return res.status(501).json({
        ok: false,
        reason: "Stripe is not configured yet on this deployment (STRIPE_SECRET_KEY unset).",
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: catalog.currency,
            unit_amount: item.unit_amount,
            product_data: { name: item.name, description: item.tagline },
          },
          quantity: 1,
        },
      ],
      metadata: { packageId: item.id },
      success_url: `${publicOrigin}/?checkout=success&package=${item.id}`,
      cancel_url: `${publicOrigin}/?checkout=cancelled&package=${item.id}`,
    });

    res.json({ ok: true, url: session.url });
  });

  app.post("/api/lead", async (req, res) => {
    const body = req.body ?? {};
    const name = clip(body.name, MAX_SHORT_FIELD);
    const email = clip(body.email, MAX_SHORT_FIELD);
    if (!name || !email) {
      return res.status(400).json({ ok: false, reason: "name and email are required" });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ ok: false, reason: "email address doesn't look valid" });
    }
    const record = {
      name,
      email,
      company: clip(body.company, MAX_SHORT_FIELD),
      role: clip(body.role, MAX_SHORT_FIELD),
      need: clip(body.need, MAX_LONG_FIELD),
      notes: clip(body.notes, MAX_LONG_FIELD),
    };
    await appendJsonLine("leads.jsonl", record);
    res.json({ ok: true });
  });

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      service: "siteguard-forms-storefront",
      stripeConfigured: Boolean(stripe),
      stripeTestMode,
    });
  });

  return app;
}
