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
import { execFile } from "node:child_process";
import path from "node:path";
import express from "express";
import { orderReceivedEmail, adminOrderNotificationEmail } from "./mailer.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_SHORT_FIELD = 200;
const MAX_LONG_FIELD = 2000;

// Flat per-document price, deliberately above the bundled per-doc rate
// (roughly $6-20/doc across the bundles) so a bundle stays the obviously
// better deal rather than individual purchase quietly undercutting it.
const INDIVIDUAL_DOC_PRICE_AUD = 4900;
const MAX_CART_ITEMS = 50;

function clip(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** One bad cart entry fails the whole checkout request (caller's own
 *  message and status) rather than silently dropping it — a customer
 *  should never pay for less than what they thought was in the cart.
 *  Keeps the same status distinctions the single-item endpoint always
 *  had: 404 for something that doesn't exist, 400 for a malformed
 *  request, 409 for something real but not buyable right now. */
class CartError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
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

/** The document code list behind one completed line item -- same lookup
 *  resolveCartEntry does at checkout time, re-run here against the webhook's
 *  reconstructed {packageId, option, documentCode} metadata, because Stripe
 *  never carries a 200-document list in line-item metadata (far past its
 *  size limit). Returns null rather than throwing -- a line this webhook
 *  can't resolve should never block the other lines in the same order from
 *  being parked, or the order record from being written at all. */
function resolveOrderGroup(line, catalog, individualDocsByCode) {
  if (line.documentCode) {
    const doc = individualDocsByCode.get(line.documentCode);
    if (!doc) return null;
    return { label: `${doc.code} — ${doc.title}`, codes: [doc.code] };
  }
  if (!line.packageId) return null;
  const item = flattenCatalog(catalog).find((i) => i.id === line.packageId);
  if (!item) return null;
  const variant = line.option && item.purchaseOptions?.[line.option]
    ? { ...item, ...item.purchaseOptions[line.option] }
    : item;
  const codes = (variant.documents ?? []).map((d) => d.code);
  if (!codes.length) return null;
  return { label: variant.name ?? item.name, codes };
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
  individualDocsPath,
  varDir,
  publicDir,
  stripe,
  stripeTestMode,
  stripeWebhookSecret,
  publicOrigin,
  mailer,
  adminNotificationEmail,
  orderIntakeUrl,
  orderIntakeApiKey,
  parkOrder,
  fetchImpl = fetch,
}) {
  async function loadCatalog() {
    const raw = await readFile(catalogPath, "utf8");
    return JSON.parse(raw);
  }

  /** The individual-document catalog: every real shippable SWMS/ITP/Forms/
   *  Register/Plan/Policy document, one flat price. Separate file from
   *  packages.json on purpose — bundles' own document lists already pushed
   *  that file past 2MB; 680 more items with no nested list of their own
   *  stays a much smaller, independently-cacheable fetch. */
  async function loadIndividualDocs() {
    if (!individualDocsPath) return [];
    const raw = await readFile(individualDocsPath, "utf8");
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

  /** Records a paid order in SiteGuard-Forms for manual review and
   *  delivery — the *only* thing a completed checkout does. Was the
   *  Artifact Factory's storefront-orders route (creating an ArtifactJob)
   *  until 2026-09-05's consolidation workstream 4; same shape, same
   *  purpose (a human reviews and delivers by hand, per ORDER_SITE.md),
   *  new destination. Best-effort: if the intake is unreachable, the order
   *  still lands in orders.jsonl and this is logged as a failure, but the
   *  customer's payment/webhook response isn't affected. Idempotency (a
   *  redelivered webhook) is the intake's job, keyed on stripeSessionId —
   *  see storefrontOrders in SiteGuard-Forms' shared/schema.ts. */
  async function notifyOrderIntake(order) {
    if (!orderIntakeUrl || !orderIntakeApiKey) {
      await appendJsonLine("order-notify-events.jsonl", {
        ok: false,
        reason: "ORDER_INTAKE_URL/API_KEY not configured",
        order,
      });
      return;
    }
    try {
      const res = await fetchImpl(orderIntakeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-storefront-api-key": orderIntakeApiKey },
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

  /** Retrieves the real, hash-verified files for one order's line items and
   *  parks them in a review folder on the library host -- it does not send
   *  anything to the customer. Per Dan (2026-10-04): human stays in the
   *  loop at this stage, so the only output here is "here's what's parked
   *  and where", for the admin email to carry; actually delivering it is
   *  still a person's decision.
   *
   *  Runs over SSH with a key that's forced to exactly one remote command
   *  (see ai-control's authorized_keys) -- this process can trigger a park,
   *  nothing else, even if the storefront itself were compromised. Never
   *  throws: a park failure must not stop the order record, the intake
   *  notification, or either email from going out; it just means the admin
   *  email says so instead of giving a folder path. */
  async function parkOrderFiles(orderId, groups) {
    if (!parkOrder?.host || !parkOrder?.user || !parkOrder?.keyPath) {
      await appendJsonLine("park-order-events.jsonl", {
        ok: false,
        reason: "parkOrder not configured",
        orderId,
      });
      return { ok: false, reason: "not configured" };
    }
    if (!groups.length) {
      return { ok: false, reason: "no resolvable document groups on this order" };
    }
    return new Promise((resolve) => {
      const child = execFile(
        "ssh",
        [
          "-i", parkOrder.keyPath,
          "-o", "BatchMode=yes",
          "-o", "ConnectTimeout=10",
          `${parkOrder.user}@${parkOrder.host}`,
        ],
        { timeout: 30000, maxBuffer: 10 * 1024 * 1024 },
        async (err, stdout, stderr) => {
          if (err) {
            const result = { ok: false, reason: err.message, stderr: stderr?.slice(0, 2000) };
            await appendJsonLine("park-order-events.jsonl", { orderId, ...result });
            resolve(result);
            return;
          }
          try {
            const parsed = JSON.parse(stdout.trim().split("\n").pop());
            await appendJsonLine("park-order-events.jsonl", { orderId, ...parsed });
            resolve(parsed);
          } catch {
            const result = { ok: false, reason: "unparseable park_order.py output", stdout: stdout?.slice(0, 2000) };
            await appendJsonLine("park-order-events.jsonl", { orderId, ...result });
            resolve(result);
          }
        },
      );
      child.stdin.write(JSON.stringify({ orderId, groups }));
      child.stdin.end();
    });
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
        const customerEmail = session.customer_details?.email ?? null;
        const projectAddress = customFieldValue(session, "project_address");
        const clientName = customFieldValue(session, "client_name");
        const siteNotes = customFieldValue(session, "site_notes");

        // The webhook event itself never carries line items (a slim session
        // object) — a cart of more than one thing means a real follow-up
        // call to actually see what was bought. price.product is expanded
        // because that's where each line item's own metadata (packageId/
        // option, or documentCode) landed when the session was created.
        let items = [];
        try {
          const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
            expand: ["data.price.product"],
            limit: MAX_CART_ITEMS,
          });
          items = lineItems.data.map((li) => ({
            name: li.description,
            amountTotal: li.amount_total,
            packageId: li.price?.product?.metadata?.packageId ?? null,
            option: li.price?.product?.metadata?.option ?? null,
            documentCode: li.price?.product?.metadata?.documentCode ?? null,
          }));
        } catch (err) {
          console.error("Failed to list line items for completed session", session.id, err);
        }

        await appendJsonLine("orders.jsonl", {
          event: "checkout.session.completed",
          sessionId: session.id,
          items,
          customerEmail,
          projectAddress,
          clientName,
          amountTotal: session.amount_total,
          currency: session.currency,
        });

        if (items.length && customerEmail && projectAddress && clientName) {
          // The external intake's schema is one row per package, built
          // before carts existed — a multi-item cart becomes one intake
          // call per line rather than a schema change on that side, all
          // sharing the same session/customer/address so they're plainly
          // one order on review.
          for (const line of items) {
            await notifyOrderIntake({
              packageId: line.packageId ?? line.documentCode ?? "unknown",
              packageName: line.name,
              option: line.option ?? undefined,
              stripeSessionId: session.id,
              customerEmail,
              projectAddress,
              clientName,
              siteNotes: siteNotes ?? undefined,
              amountTotal: line.amountTotal ?? undefined,
              currency: session.currency ?? undefined,
            });
          }
          const combinedName = items.map((i) => i.name).join(", ");
          await sendMailBestEffort(
            customerEmail,
            orderReceivedEmail({ packageName: combinedName, projectAddress }),
            "order-received",
          );

          // Retrieve the real files and park them for review -- does not
          // send anything to the customer. A line this can't resolve (or a
          // park failure entirely) never blocks the emails above; the admin
          // email just says so instead of giving a folder path, and Dan
          // pulls it by hand.
          const catalogForPark = await loadCatalog();
          const individualDocsForPark = await loadIndividualDocs();
          const individualDocsByCodeForPark = new Map(individualDocsForPark.map((d) => [d.code, d]));
          const groups = items
            .map((line) => resolveOrderGroup(line, catalogForPark, individualDocsByCodeForPark))
            .filter(Boolean);
          const parkResult = await parkOrderFiles(session.id, groups);

          if (adminNotificationEmail) {
            await sendMailBestEffort(
              adminNotificationEmail,
              adminOrderNotificationEmail({
                items,
                customerEmail,
                clientName,
                projectAddress,
                siteNotes,
                amountTotal: session.amount_total,
                currency: session.currency,
                sessionId: session.id,
                parkResult,
              }),
              "admin-order-notification",
            );
          }
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
    app.use(express.static(publicDir, { maxAge: 60000 })); // 60s -- short on purpose while this catalog is under active iteration
  }

  app.get("/api/packages", async (_req, res) => {
    // packages.json carries an internal-only _comment field (repo paths,
    // mastering/QA process notes) for maintainers reading the file -- never
    // meant to leave this server. Strip any top-level _-prefixed key before
    // it goes out over the public API.
    const { _comment, ...catalog } = await loadCatalog();
    res.json({ ...catalog, stripeConfigured: Boolean(stripe), stripeTestMode });
  });

  app.get("/api/documents", async (_req, res) => {
    const documents = await loadIndividualDocs();
    res.json({
      currency: "aud",
      unitAmount: INDIVIDUAL_DOC_PRICE_AUD,
      documents,
      stripeConfigured: Boolean(stripe),
      stripeTestMode,
    });
  });

  /** Resolves one cart entry to a Stripe line item, or throws a CartError
   *  with the exact reason — the whole checkout fails together rather than
   *  silently dropping one bad entry from what the customer thought they
   *  were buying. Two entry shapes: { packageId, option? } for a catalog
   *  item/rung, { documentCode } for a single document at the flat rate. */
  async function resolveCartEntry(entry, catalog, individualDocsByCode) {
    if (entry && typeof entry.documentCode === "string") {
      const doc = individualDocsByCode.get(entry.documentCode);
      if (!doc) throw new CartError(`unknown document code: ${entry.documentCode}`, 404);
      return {
        name: `${doc.code} — ${doc.title}`,
        unit_amount: INDIVIDUAL_DOC_PRICE_AUD,
        description: "Single document",
        metadata: { documentCode: doc.code },
      };
    }

    const packageId = entry?.packageId;
    if (!packageId || typeof packageId !== "string") {
      throw new CartError("each cart entry needs a packageId or a documentCode", 400);
    }
    const item = flattenCatalog(catalog).find((i) => i.id === packageId);
    if (!item) throw new CartError(`unknown packageId: ${packageId}`, 404);

    // An item with purchaseOptions (e.g. the Domestic/Light/Heavy/ISO-OFSC
    // rung picker) carries no price of its own — every price, name and tier
    // lives on the selected option, and picking one is mandatory. This used
    // to only affect what the page *displayed*; checkout silently charged
    // item.unit_amount regardless of which tab was selected. No live item
    // used purchaseOptions yet, so nothing was ever overcharged, but a rung
    // picker needs this to actually work before it's the first thing that does.
    let variant = item;
    let optionKey = null;
    if (item.purchaseOptions) {
      optionKey = typeof entry.option === "string" ? entry.option : null;
      const chosen = optionKey ? item.purchaseOptions[optionKey] : undefined;
      if (!chosen) {
        throw new CartError(
          `option is required for ${packageId} — one of: ${Object.keys(item.purchaseOptions).join(", ")}`,
          400,
        );
      }
      variant = { ...item, ...chosen };
    }

    if (variant.tier === "quote") {
      throw new CartError(`${packageId} is quote-based — submit the enquiry form instead.`);
    }
    if (variant.tier === "coming-soon") {
      throw new CartError(`${packageId} isn't available for purchase yet — register interest instead.`);
    }

    return {
      name: variant.name,
      unit_amount: variant.unit_amount,
      description: variant.tagline ?? variant.description,
      metadata: { packageId: item.id, ...(optionKey ? { option: optionKey } : {}) },
    };
  }

  app.post("/api/checkout", async (req, res) => {
    // Back-compat single-item shape ({ packageId, option }) and the cart
    // shape ({ cart: [...] }) both land here — a lone "Buy Now" is just a
    // one-entry cart, not a different code path to keep in sync.
    const body = req.body ?? {};
    const cart = Array.isArray(body.cart)
      ? body.cart
      : body.packageId
        ? [{ packageId: body.packageId, option: body.option }]
        : null;

    if (!cart || cart.length === 0) {
      return res.status(400).json({ ok: false, reason: "cart is required and must not be empty" });
    }
    if (cart.length > MAX_CART_ITEMS) {
      return res.status(400).json({ ok: false, reason: `cart is limited to ${MAX_CART_ITEMS} items` });
    }
    if (!stripe) {
      return res.status(501).json({
        ok: false,
        reason: "Stripe is not configured yet on this deployment (STRIPE_SECRET_KEY unset).",
      });
    }

    const catalog = await loadCatalog();
    const individualDocs = await loadIndividualDocs();
    const individualDocsByCode = new Map(individualDocs.map((d) => [d.code, d]));

    let resolved;
    try {
      resolved = await Promise.all(cart.map((entry) => resolveCartEntry(entry, catalog, individualDocsByCode)));
    } catch (err) {
      if (err instanceof CartError) {
        return res.status(err.status).json({ ok: false, reason: err.message });
      }
      throw err;
    }

    try {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_creation: "always",
        line_items: resolved.map((line) => ({
          price_data: {
            currency: catalog.currency,
            unit_amount: line.unit_amount,
            product_data: { name: line.name, description: line.description, metadata: line.metadata },
          },
          quantity: 1,
        })),
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
        metadata: { cartSize: String(resolved.length) },
        success_url: `${publicOrigin}/?checkout=success`,
        cancel_url: `${publicOrigin}/?checkout=cancelled`,
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
