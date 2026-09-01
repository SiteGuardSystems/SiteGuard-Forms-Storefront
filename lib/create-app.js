// The Express app itself, as a pure factory with no side effects (no env
// reads, no listen()) — so tests can build one against a temp catalog/var
// dir and a fake Stripe client, and server.js can build the real one.
//
// Purchase model per docs/ORDER_SITE.md (2026-08-03, Dan's own decision):
// purchase and order, one-off only. No subscriptions, no self-serve credit
// packs — "Manual fulfilment makes the mastering gate hold by construction."
// A customer pays once, tells us the project right there in Stripe Checkout,
// and a human reviews and masters the result before anything ships. This
// file used to also run a credits ledger and magic-link redemption flow for
// a subscription/project-pack model — removed; see git history if that's
// ever revisited (only after the cloud migration ORDER_SITE.md names).
import { readFile, appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import express from "express";
import { orderReceivedEmail } from "./mailer.js";

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

/** Pulls a Stripe Checkout custom_field's text value out by key. */
function customFieldValue(session, key) {
  const field = session.custom_fields?.find((f) => f.key === key);
  return field?.text?.value ?? null;
}

export function createApp({
  catalogPath,
  varDir,
  publicDir,
  stripe,
  stripeTestMode,
  stripeWebhookSecret,
  publicOrigin,
  mailer,
  artifactFactoryOrderUrl,
  artifactFactoryApiKey,
  fetchImpl = fetch,
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

  /** Best-effort email send: logs the outcome either way, never throws. An
   *  email-provider outage must never take down order processing — the
   *  JSONL logs remain the source of truth regardless. */
  async function sendMailBestEffort(to, { subject, html, text }, logLabel) {
    if (!mailer?.configured || !to) return;
    const result = await mailer.send({ to, subject, html, text });
    await appendJsonLine("mail-events.jsonl", { to, subject, label: logLabel, ...result });
  }

  /** Turns a paid order into an ArtifactJob in the Artifact Factory — the
   *  *only* thing a completed checkout does. Best-effort: if the factory is
   *  unreachable, the order still lands in orders.jsonl and this is logged
   *  as a failure, but the customer's payment/webhook response isn't
   *  affected. Idempotency (a redelivered webhook) is the factory's job,
   *  keyed on stripeSessionId — see routes/storefront-orders.ts. */
  async function notifyArtifactFactory(order) {
    if (!artifactFactoryOrderUrl || !artifactFactoryApiKey) {
      await appendJsonLine("order-notify-events.jsonl", {
        ok: false,
        reason: "ARTIFACT_FACTORY_ORDER_URL/API_KEY not configured",
        order,
      });
      return;
    }
    try {
      const res = await fetchImpl(artifactFactoryOrderUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-storefront-api-key": artifactFactoryApiKey },
        body: JSON.stringify(order),
      });
      const body = await res.json().catch(() => ({}));
      await appendJsonLine("order-notify-events.jsonl", { ok: res.ok, status: res.status, body, order });
    } catch (err) {
      await appendJsonLine("order-notify-events.jsonl", {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        order,
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
        const packageId = session.metadata?.packageId ?? null;
        const packageName = session.metadata?.packageName ?? packageId;
        const customerEmail = session.customer_details?.email ?? null;
        const projectAddress = customFieldValue(session, "project_address");
        const clientName = customFieldValue(session, "client_name");
        const siteNotes = customFieldValue(session, "site_notes");

        await appendJsonLine("orders.jsonl", {
          event: "checkout.session.completed",
          sessionId: session.id,
          packageId,
          customerEmail,
          projectAddress,
          clientName,
          amountTotal: session.amount_total,
          currency: session.currency,
        });

        if (packageId && customerEmail && projectAddress && clientName) {
          await notifyArtifactFactory({
            packageId,
            packageName,
            stripeSessionId: session.id,
            customerEmail,
            projectAddress,
            clientName,
            siteNotes: siteNotes ?? undefined,
            amountTotal: session.amount_total ?? undefined,
            currency: session.currency ?? undefined,
          });
          await sendMailBestEffort(
            customerEmail,
            orderReceivedEmail({ packageName, projectAddress }),
            "order-received",
          );
        } else {
          // Shouldn't happen — custom_fields are required at checkout — but
          // an incomplete order becoming a silent no-op would be worse than
          // a loud one.
          console.warn("checkout.session.completed missing required order fields", { sessionId: session.id });
        }
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

    try {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_creation: "always",
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
        // Collected on Stripe's own hosted page — one order, one project, no
        // separate post-payment intake step to build or for a customer to
        // lose track of. Stripe caps custom_fields text at 255 chars (its
        // limit, not ours) — site notes get truncated further server-side
        // in the webhook handler's own MAX_LONG_FIELD if that ever changes.
        custom_fields: [
          {
            key: "project_address",
            label: { type: "custom", custom: "Project address" },
            type: "text",
            text: { minimum_length: 1, maximum_length: 255 },
          },
          {
            key: "client_name",
            label: { type: "custom", custom: "Client / company name" },
            type: "text",
            text: { minimum_length: 1, maximum_length: 200 },
          },
          {
            key: "site_notes",
            label: { type: "custom", custom: "Site notes (optional)" },
            type: "text",
            optional: true,
            text: { maximum_length: 255 },
          },
        ],
        metadata: { packageId: item.id, packageName: item.name },
        success_url: `${publicOrigin}/?checkout=success&package=${item.id}`,
        cancel_url: `${publicOrigin}/?checkout=cancelled&package=${item.id}`,
      });

      res.json({ ok: true, url: session.url });
    } catch (err) {
      // A Stripe API error here must never crash the process — it did once,
      // via an unhandled rejection, and took the whole service down with it.
      console.error("Stripe checkout session creation failed", err);
      res.status(502).json({ ok: false, reason: "Checkout is temporarily unavailable — please try again shortly." });
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
