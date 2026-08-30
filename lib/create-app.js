// The Express app itself, as a pure factory with no side effects (no env
// reads, no listen()) — so tests can build one against a temp catalog/var
// dir and a fake Stripe client, and server.js can build the real one.
import { readFile, appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import express from "express";
import { createCreditsStore } from "./credits-store.js";
import { createMagicLinkToken, verifyMagicLinkToken } from "./magic-link.js";

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
  magicLinkSecret,
}) {
  const credits = createCreditsStore(varDir);

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

  /** Grants credits once per sourceId (checkout session or invoice id) and
   *  logs a magic link so the customer (today: Daniel, manually) can reach
   *  the redemption form. No email sending yet — see README. */
  async function grantAndIssueLink({ stripeCustomerId, email, packageId, amount, source, sourceId }) {
    if (!stripeCustomerId || !amount) return;
    if (await credits.wasAlreadyGranted(sourceId)) return; // webhook redelivery guard
    await credits.grantCredits({ stripeCustomerId, email, packageId, amount, source, sourceId });
    if (magicLinkSecret) {
      const token = createMagicLinkToken(magicLinkSecret, { stripeCustomerId, email });
      await appendJsonLine("magic-links.jsonl", {
        stripeCustomerId,
        email,
        packageId,
        redeemUrl: `${publicOrigin}/redeem?token=${token}`,
      });
    }
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
          option: session.metadata?.option ?? null,
          customerEmail: session.customer_details?.email ?? null,
          amountTotal: session.amount_total,
          currency: session.currency,
        });

        const meta = session.metadata ?? {};
        const credited = Number(meta.credits ?? 0);
        // Covers both the one-time "project pack" purchase and a
        // subscription's first period — Checkout fires this event either
        // way, with the credit count carried in the session's own metadata.
        if (credited > 0 && (meta.option === "projectPack" || session.mode === "subscription")) {
          await grantAndIssueLink({
            stripeCustomerId: session.customer,
            email: session.customer_details?.email ?? meta.email ?? null,
            packageId: meta.packageId,
            amount: credited,
            source: session.mode === "subscription" ? "subscription-initial" : "project-pack",
            sourceId: session.id,
          });
        }

        // TODO(fulfillment): the "pdf" option and any non-credit purchase
        // still just land in orders.jsonl — actually delivering a file is
        // the same not-yet-built extension point as before. Needs a
        // decision on delivery mechanism, and confirmation the specific
        // document is QA-clean before being handed to a paying customer —
        // the library is still being developed/hardened as of 2026-08-30,
        // not yet approved to reach real clients.
      }

      // Subscription renewals: Checkout only fires checkout.session.completed
      // once, at signup. Every later billing period shows up as an invoice.
      if (event.type === "invoice.paid") {
        const invoice = event.data.object;
        if (invoice.billing_reason === "subscription_cycle" && invoice.subscription) {
          const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
          const meta = subscription.metadata ?? {};
          const amount = Number(meta.credits ?? 0);
          if (amount > 0) {
            await grantAndIssueLink({
              stripeCustomerId: invoice.customer,
              email: invoice.customer_email ?? meta.email ?? null,
              packageId: meta.packageId,
              amount,
              source: "subscription-renewal",
              sourceId: invoice.id,
            });
          }
        }
      }

      res.json({ received: true });
    },
  );

  app.use(express.json());
  if (publicDir) {
    app.get("/redeem", (_req, res) => res.sendFile(path.join(publicDir, "redeem.html")));
    app.use(express.static(publicDir));
  }

  app.get("/api/packages", async (_req, res) => {
    const catalog = await loadCatalog();
    res.json({ ...catalog, stripeConfigured: Boolean(stripe), stripeTestMode });
  });

  app.post("/api/checkout", async (req, res) => {
    const { packageId, option } = req.body ?? {};
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

    // purchaseOptions (pdf / projectPack / subscription) override the
    // item's flat unit_amount when a specific option is requested. Items
    // without purchaseOptions ignore `option` entirely and behave exactly
    // as a plain one-time purchase always has.
    const chosen = option && item.purchaseOptions ? item.purchaseOptions[option] : null;
    if (option && item.purchaseOptions && !chosen) {
      return res.status(400).json({ ok: false, reason: "unknown purchase option for this package" });
    }

    const isSubscription = chosen?.interval != null;
    const unitAmount = chosen?.unit_amount ?? item.unit_amount;
    const metadata = {
      packageId: item.id,
      option: option ?? "standard",
      credits: String(chosen?.credits ?? 0),
    };

    const session = await stripe.checkout.sessions.create({
      mode: isSubscription ? "subscription" : "payment",
      ...(isSubscription ? {} : { customer_creation: "always" }),
      line_items: [
        {
          price_data: {
            currency: catalog.currency,
            unit_amount: unitAmount,
            product_data: { name: `${item.name}${chosen ? ` — ${chosen.label}` : ""}`, description: item.tagline },
            ...(isSubscription ? { recurring: { interval: chosen.interval } } : {}),
          },
          quantity: 1,
        },
      ],
      metadata,
      ...(isSubscription ? { subscription_data: { metadata } } : {}),
      success_url: `${publicOrigin}/?checkout=success&package=${item.id}`,
      cancel_url: `${publicOrigin}/?checkout=cancelled&package=${item.id}`,
    });

    res.json({ ok: true, url: session.url });
  });

  app.get("/api/redeem/status", async (req, res) => {
    const verified = verifyMagicLinkToken(magicLinkSecret ?? "", String(req.query.token ?? ""));
    if (!verified.ok) {
      return res.status(400).json({ ok: false, reason: verified.reason });
    }
    const balance = await credits.getBalance(verified.stripeCustomerId);
    res.json({ ok: true, email: verified.email, packages: balance?.packages ?? {} });
  });

  app.post("/api/redeem", async (req, res) => {
    const { token, packageId, projectAddress, clientName, siteNotes } = req.body ?? {};
    const verified = verifyMagicLinkToken(magicLinkSecret ?? "", String(token ?? ""));
    if (!verified.ok) {
      return res.status(400).json({ ok: false, reason: verified.reason });
    }
    const address = clip(projectAddress, MAX_SHORT_FIELD);
    const client = clip(clientName, MAX_SHORT_FIELD);
    if (!packageId || !address || !client) {
      return res.status(400).json({ ok: false, reason: "packageId, projectAddress and clientName are required" });
    }
    try {
      const remaining = await credits.redeemCredit({
        stripeCustomerId: verified.stripeCustomerId,
        email: verified.email,
        packageId,
        projectAddress: address,
        clientName: client,
        siteNotes: clip(siteNotes, MAX_LONG_FIELD),
      });
      res.json({ ok: true, remaining });
    } catch (err) {
      if (err.code === "NO_CREDITS") {
        return res.status(409).json({ ok: false, reason: "No project credits remaining for this package." });
      }
      throw err;
    }
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
