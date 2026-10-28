// The Express app, as a pure factory with no side effects (no env reads, no
// listen()) -- tests build one against a temp catalogue/var dir and a fake
// Stripe client; server.js builds the real one.
//
// What this process does (17 Oct 2026):
//   * serves the static site built into dist/ by scripts/build-site.mjs;
//   * one-off checkout through Stripe for packs and single documents that the
//     catalogue (Hseq-Dev docs/build_catalogue.py) marks as on sale -- every
//     price is re-read from data/catalogue.json here, never trusted from the
//     browser;
//   * the Stripe webhook: records the order, emails the receipt, and passes
//     each line to SiteGuard-Forms' storefront-orders intake, which generates
//     the documents and emails them (with its own human-review switch);
//   * the enquiry form for both websites (/api/lead).
// Subscriptions are not sold here: "Subscribe" links go to the FORMS app's
// signup, which runs its own Stripe subscription checkout.
import { readFile, appendFile, mkdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import express from "express";
import { orderReceivedEmail, adminOrderNotificationEmail, leadNotificationEmail } from "./mailer.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Partner referral codes (?ref=CODE); same rule as scripts/lib/trust.mjs.
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9-]{1,23}$/;
const MAX_SHORT_FIELD = 200;
const MAX_LONG_FIELD = 2000;
const MAX_CART_ITEMS = 50;

function clip(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** One bad cart entry fails the whole checkout (a customer must never pay
 *  for less than they thought was in the cart): 404 unknown, 400 malformed,
 *  409 real but not on sale. */
class CartError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

/** Fixed-window rate limiter, per client IP, in memory. Enough for one small
 *  process; a restart resets it, which is acceptable. */
export function rateLimit({ windowMs, max, message }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip ?? "unknown";
    const entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      if (hits.size > 10_000) for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((entry.start + windowMs - now) / 1000)));
      return res.status(429).json({ ok: false, reason: message });
    }
    next();
  };
}

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

// `csp` is CSP plus anything the landing-page video needs (server.js adds the
// YouTube player's origin via scripts/lib/video.mjs withVideoCsp).
const securityHeaders = (csp = CSP) => function securityHeaders(_req, res, next) {
  res.setHeader("Content-Security-Policy", csp);
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  next();
};

/** Pulls a Stripe Checkout custom_field's text value out by key. */
function customFieldValue(session, key) {
  const field = session.custom_fields?.find((f) => f.key === key);
  return field?.text?.value ?? null;
}

/** The document codes behind one completed line item, for the optional
 *  park-for-review step. Never throws. */
function resolveOrderGroup(line, catalogue) {
  if (line.documentCode) {
    const doc = catalogue.documents.find((d) => d.code === line.documentCode);
    return doc ? { label: `${doc.code} ${doc.title}`, codes: [doc.code] } : null;
  }
  const pack = catalogue.packs.find((p) => p.id === line.packageId);
  return pack?.documents?.length ? { label: pack.name, codes: pack.documents } : null;
}

export function createApp({
  catalogPath,
  varDir,
  publicDir,
  stripe,
  stripeTestMode,
  stripeWebhookSecret,
  stripeAutomaticTax = true,
  allowUnreleasedCheckout = false,
  publicOrigin,
  mailer,
  adminNotificationEmail,
  leadNotificationEmailTo,
  leadAllowedOrigins = [],
  orderIntakeUrl,
  orderIntakeApiKey,
  parkOrder,
  fetchImpl = fetch,
  trustProxy = false,
  beta = false,
  csp = CSP,
}) {
  let cache = { mtimeMs: 0, data: null };
  async function loadCatalog() {
    const s = await stat(catalogPath);
    if (!cache.data || s.mtimeMs !== cache.mtimeMs) {
      cache = { mtimeMs: s.mtimeMs, data: JSON.parse(await readFile(catalogPath, "utf8")) };
    }
    return cache.data;
  }

  // Unreleased packs can be bought only against a Stripe TEST key, and only
  // when explicitly allowed (end-to-end testing before the library is
  // released). Never with a live key.
  const canSellUnreleased = Boolean(allowUnreleasedCheckout && stripeTestMode);

  async function appendJsonLine(file, record) {
    await mkdir(varDir, { recursive: true });
    await appendFile(
      path.join(varDir, file),
      JSON.stringify({ ...record, at: new Date().toISOString() }) + "\n",
      "utf8",
    );
  }

  /** Stripe explicitly documents at-least-once delivery -- a webhook can be
   *  redelivered for the same event even on a normal day, not just after a
   *  timeout. Without this, a redelivery re-runs the entire handler:
   *  duplicate customer email, duplicate admin email, a second park
   *  attempt. Checked by reading the small processed-events log back
   *  (cheap at this order volume) rather than keeping an in-memory set,
   *  so it survives a process restart between deliveries. */
  async function isEventProcessed(eventId) {
    try {
      const raw = await readFile(path.join(varDir, "processed-webhook-events.jsonl"), "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .some((line) => {
          try {
            return JSON.parse(line).eventId === eventId;
          } catch {
            return false;
          }
        });
    } catch (err) {
      if (err.code === "ENOENT") return false;
      throw err;
    }
  }

  async function markEventProcessed(eventId) {
    await appendJsonLine("processed-webhook-events.jsonl", { eventId });
  }

  /** Best-effort email send: logs the outcome either way, never throws. An
   *  email-provider outage must never take down order processing — the
   *  JSONL logs remain the source of truth regardless. */
  async function sendMailBestEffort(to, { subject, html, text }, logLabel) {
    if (!mailer?.configured || !to) return;
    const result = await mailer.send({ to, subject, html, text });
    await appendJsonLine("mail-events.jsonl", { to, subject, label: logLabel, ...result });
  }

  // Queue 4B item 6 (21 Oct 2026): "email Dan when a Stripe webhook fails its
  // signature check or throws." A wrong or rotated webhook secret fails
  // silently today -- Stripe gets a 400 and doesn't retry a 4xx, and nothing
  // tells Dan a real checkout never fulfilled. Rate-limited per `kind` to one
  // an hour (a signature-check storm from a misconfigured secret would
  // otherwise send one email per attempt) using a small state file in
  // `varDir`, which already holds this app's other persistent state.
  const alertState = new Map();
  async function alertAdmin(kind, subject, text) {
    if (!adminNotificationEmail || !mailer?.configured) return;
    const last = alertState.get(kind) ?? 0;
    if (Date.now() - last < 60 * 60 * 1000) return;
    alertState.set(kind, Date.now());
    await sendMailBestEffort(adminNotificationEmail, {
      subject: `[SiteGuard alert] ${subject}`,
      text,
      html: `<p>${text.replace(/\n/g, "<br>")}</p>`,
    }, `alert:${kind}`);
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
      return null; // not configured: logged locally, nothing to retry
    }
    try {
      const res = await fetchImpl(orderIntakeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-storefront-api-key": orderIntakeApiKey },
        body: JSON.stringify(order),
      });
      const body = await res.json().catch(() => ({}));
      await appendJsonLine("order-notify-events.jsonl", { ok: res.ok, status: res.status, body, order });
      // 5xx or no answer: retry (Stripe redelivers). 4xx: the intake refused
      // the record itself; retrying won't help, so it's left in the log for Dan.
      return res.ok || res.status < 500;
    } catch (err) {
      await appendJsonLine("order-notify-events.jsonl", {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        order,
      });
      return false;
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
  async function parkOrderFiles(orderId, groups, customer) {
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
        // 12s, not 30s: this runs inside the Stripe webhook handler before
        // it responds, alongside a Stripe API call and two email sends --
        // Stripe gives roughly 20s total before it considers the delivery
        // failed and retries, which (now that redeliveries are idempotent,
        // see isEventProcessed) is recoverable but still means a customer
        // waits longer than they should. A self-serve order is at most a
        // few dozen small .docx files; 12s is generous for that, not for a
        // pathological one.
        { timeout: 12000, maxBuffer: 10 * 1024 * 1024 },
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
      child.stdin.write(JSON.stringify({ orderId, groups, customer }));
      child.stdin.end();
    });
  }


  const inFlight = new Set();

  /** Records a paid order, hands each line to the FORMS intake, and sends the
   *  receipt and the admin alert. Throws if the line items can't be read, so
   *  the webhook answers 500 and Stripe redelivers. */
  async function fulfil(session) {
    const customerEmail = session.customer_details?.email ?? null;
    const projectAddress = customFieldValue(session, "project_address");
    const clientName = customFieldValue(session, "client_name");
    const siteNotes = customFieldValue(session, "site_notes");
    const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
      expand: ["data.price.product"],
      limit: MAX_CART_ITEMS,
    });
    const items = lineItems.data.map((li) => ({
      name: li.description,
      amountTotal: li.amount_total,
      packageId: li.price?.product?.metadata?.packageId ?? null,
      documentCode: li.price?.product?.metadata?.documentCode ?? null,
    }));
    await appendJsonLine("orders.jsonl", {
      event: "checkout.session.paid",
      sessionId: session.id,
      items,
      customerEmail,
      projectAddress,
      clientName,
      amountTotal: session.amount_total,
      amountTax: session.total_details?.amount_tax ?? null,
      currency: session.currency,
      termsVersion: session.metadata?.termsVersion ?? null,
    });
    if (!(items.length && customerEmail && projectAddress && clientName)) {
      console.warn("paid session missing required order fields", { sessionId: session.id });
      return;
    }
    // One intake call per line: the FORMS intake records one row per
    // package. A single document goes through as "doc:<CODE>". The intake is
    // idempotent on the Stripe session id.
    // The intake is idempotent on stripeSessionId, which it holds unique per
    // row, so each line carries "<session>:<item>" -- stable across Stripe
    // retries and distinct per line, so a cart of several packs records them all.
    const failed = [];
    for (const line of items) {
      const packageId = line.packageId ?? (line.documentCode ? `doc:${line.documentCode}` : "unknown");
      const ok = await notifyOrderIntake({
        packageId,
        packageName: line.name,
        stripeSessionId: `${session.id}:${packageId}`,
        customerEmail,
        projectAddress,
        clientName,
        siteNotes: siteNotes ?? undefined,
        amountTotal: line.amountTotal ?? undefined,
        currency: session.currency ?? undefined,
      });
      if (ok === false) failed.push(packageId);
    }
    if (failed.length) throw new Error(`order intake failed for ${failed.join(", ")}`);
    await sendMailBestEffort(
      customerEmail,
      orderReceivedEmail({ packageName: items.map((i) => i.name).join(", "), projectAddress }),
      "order-received",
    );
    let parkResult;
    if (parkOrder) {
      const catalogue = await loadCatalog();
      const groups = items.map((line) => resolveOrderGroup(line, catalogue)).filter(Boolean);
      parkResult = await parkOrderFiles(session.id, groups, {
        email: customerEmail, clientName, projectAddress, siteNotes: siteNotes ?? undefined,
        amountTotal: session.amount_total, currency: session.currency,
      });
    }
    if (adminNotificationEmail) {
      await sendMailBestEffort(
        adminNotificationEmail,
        adminOrderNotificationEmail({
          items, customerEmail, clientName, projectAddress, siteNotes,
          amountTotal: session.amount_total, currency: session.currency, sessionId: session.id,
          parkResult: parkOrder ? parkResult : { ok: true, dir: "Delivery: SiteGuard FORMS (Admin > Delivery)" },
        }),
        "admin-order-notification",
      );
    }
  }

  const app = express();
  app.disable("x-powered-by");
  if (trustProxy) app.set("trust proxy", trustProxy);
  app.use(securityHeaders(csp));

  // Stripe webhook needs the raw body for signature verification -- must be
  // registered before express.json() touches the request.
  app.post(
    "/api/webhook/stripe",
    express.raw({ type: "application/json", limit: "1mb" }),
    async (req, res) => {
      if (!stripe || !stripeWebhookSecret) {
        return res.status(501).json({ ok: false, reason: "Stripe not configured" });
      }
      let event;
      try {
        event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], stripeWebhookSecret);
      } catch (err) {
        // Stripe does not retry a 4xx, so a wrong/rotated secret fails every
        // delivery silently unless someone is told.
        await alertAdmin("webhook-signature", "Stripe webhook signature check failed",
          `A webhook delivery failed signature verification: ${err.message}\n\nIf this keeps happening, STRIPE_WEBHOOK_SECRET on forms-vps may not match the live endpoint's current signing secret -- check Stripe Dashboard -> Developers -> Webhooks.`);
        return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
      }

      // Fulfil a paid checkout once. "completed" can arrive before the money
      // has cleared (delayed payment methods): those are fulfilled on
      // "async_payment_succeeded" instead.
      const fulfilTypes = ["checkout.session.completed", "checkout.session.async_payment_succeeded"];
      if (fulfilTypes.includes(event.type)) {
        const session = event.data.object;
        if (session.payment_status !== "paid") {
          await appendJsonLine("orders-awaiting-payment.jsonl", { sessionId: session.id, eventId: event.id, paymentStatus: session.payment_status ?? null });
          return res.json({ received: true, awaitingPayment: true });
        }
        // Keyed on the session, so a redelivery or the second of the two
        // event types never fulfils twice. Marked only AFTER the order is
        // recorded and handed on; a failure before then returns 500 so
        // Stripe retries.
        if (inFlight.has(session.id) || (await isEventProcessed(session.id))) {
          return res.json({ received: true, duplicate: true });
        }
        inFlight.add(session.id);
        try {
          await fulfil(session);
          await markEventProcessed(session.id);
        } catch (err) {
          console.error("Order fulfilment failed; Stripe will retry", session.id, err);
          await alertAdmin("fulfilment-failed", "Order fulfilment failed",
            `Session ${session.id} failed to fulfil: ${err instanceof Error ? err.message : String(err)}\n\nStripe will retry (up to 3 days). Check the storefront journal if it keeps failing.`);
          return res.status(500).json({ received: false });
        } finally {
          inFlight.delete(session.id);
        }
      }

      res.json({ received: true });
    },
  );

  // The enquiry form also serves siteguardsystems.com.au: CORS for the
  // allowed origins only, on this one route.
  function leadCors(req, res, next) {
    const origin = req.headers.origin;
    if (origin && leadAllowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") return res.status(origin && leadAllowedOrigins.includes(origin) ? 204 : 403).end();
    next();
  }

  app.use(express.json({ limit: "64kb" }));

  /** Resolves one cart entry to a Stripe line item from the catalogue. */
  function resolveCartEntry(entry, catalogue) {
    if (entry && typeof entry.documentCode === "string") {
      const doc = catalogue.documents.find((d) => d.code === entry.documentCode);
      if (!doc) throw new CartError(`unknown document code: ${entry.documentCode}`, 404);
      if (!doc.sellable && !canSellUnreleased) throw new CartError(`${doc.code} isn't on sale.`);
      if (!doc.price) throw new CartError(`${doc.code} has no price.`);
      return {
        name: `${doc.code} ${doc.title}`,
        unit_amount: Math.round(doc.price * 100),
        description: "Single document, PDF",
        metadata: { documentCode: doc.code },
      };
    }
    const packageId = entry?.packageId;
    if (!packageId || typeof packageId !== "string") {
      throw new CartError("each cart entry needs a packageId or a documentCode", 400);
    }
    const pack = catalogue.packs.find((p) => p.id === packageId);
    if (!pack || !pack.listed) throw new CartError(`unknown package: ${packageId}`, 404);
    if (!pack.sellable && !canSellUnreleased) throw new CartError(`${pack.name} isn't on sale.`);
    if (!pack.prices?.one_off) {
      throw new CartError(`${pack.name} is sold by subscription only. Use its Subscribe button.`);
    }
    return {
      name: pack.name,
      unit_amount: Math.round(pack.prices.one_off * 100),
      description: `${pack.count} documents, PDF`,
      metadata: { packageId: pack.id },
    };
  }

  app.post(
    "/api/checkout",
    rateLimit({ windowMs: 10 * 60_000, max: 20, message: "Too many checkout attempts. Wait a few minutes and try again." }),
    async (req, res) => {
      if (beta) {
        return res.status(503).json({ ok: false, reason: "SiteGuard FORMS is in beta: orders aren't open yet." });
      }
      const body = req.body ?? {};
      const cart = Array.isArray(body.cart) ? body.cart : null;
      if (!cart || cart.length === 0) {
        return res.status(400).json({ ok: false, reason: "cart is required and must not be empty" });
      }
      if (cart.length > MAX_CART_ITEMS) {
        return res.status(400).json({ ok: false, reason: `cart is limited to ${MAX_CART_ITEMS} items` });
      }
      if (body.acceptedTerms !== true) {
        return res.status(400).json({ ok: false, reason: "Accept the Terms of Sale and the Document Use Disclaimer to continue." });
      }
      if (!stripe) {
        return res.status(501).json({ ok: false, reason: "Checkout isn't available on this deployment." });
      }
      const catalogue = await loadCatalog();
      if (catalogue.preview && !canSellUnreleased) {
        return res.status(409).json({ ok: false, reason: "This is a preview build. Checkout is switched off." });
      }
      const seen = new Set();
      let resolved;
      try {
        resolved = cart.map((entry) => {
          if (entry && typeof entry.documentCode === "string" && entry.packageId !== undefined) {
            throw new CartError("a cart entry is either a package or a document, not both", 400);
          }
          const key = typeof entry?.documentCode === "string" ? `doc:${entry.documentCode}` : entry?.packageId;
          if (seen.has(key)) throw new CartError(`${key} is in the cart twice`, 400);
          seen.add(key);
          return resolveCartEntry(entry, catalogue);
        });
      } catch (err) {
        if (err instanceof CartError) return res.status(err.status).json({ ok: false, reason: err.message });
        throw err;
      }

      try {
        const session = await stripe.checkout.sessions.create({
          mode: "payment",
          customer_creation: "always",
          billing_address_collection: "required",
          ...(stripeAutomaticTax ? { automatic_tax: { enabled: true }, tax_id_collection: { enabled: true } } : {}),
          line_items: resolved.map((line) => ({
            price_data: {
              currency: "aud",
              unit_amount: line.unit_amount,
              tax_behavior: "exclusive",
              product_data: { name: line.name, description: line.description, metadata: line.metadata },
            },
            quantity: 1,
          })),
          custom_fields: [
            { key: "client_name", label: { type: "custom", custom: "Business name (printed on the documents)" },
              type: "text", text: { minimum_length: 1, maximum_length: 200 } },
            { key: "project_address", label: { type: "custom", custom: "Project address" },
              type: "text", text: { minimum_length: 1, maximum_length: 255 } },
            { key: "site_notes", label: { type: "custom", custom: "Notes for us (optional)" },
              type: "text", optional: true, text: { maximum_length: 255 } },
          ],
          metadata: { cartSize: String(resolved.length), termsVersion: clip(body.termsVersion, 120) },
          success_url: `${publicOrigin}/order/success/`,
          cancel_url: `${publicOrigin}/order/cancelled/`,
        });
        res.json({ ok: true, url: session.url });
      } catch (err) {
        console.error("Stripe checkout session creation failed", err);
        res.status(502).json({ ok: false, reason: "Checkout is temporarily unavailable. Please try again shortly." });
      }
    },
  );

  app.options("/api/lead", leadCors);
  app.use("/api/lead", express.urlencoded({ extended: false, limit: "16kb" }));
  app.post(
    "/api/lead",
    leadCors,
    rateLimit({ windowMs: 10 * 60_000, max: 5, message: "Too many enquiries from this connection. Try again later." }),
    async (req, res) => {
      const body = req.body ?? {};
      // Honeypot: people never fill the hidden "website" field; bots do.
      // Answer as if it worked, and keep nothing.
      if (clip(body.website, MAX_SHORT_FIELD)) {
        return req.is("application/x-www-form-urlencoded") ? res.redirect(303, "/contact/sent/") : res.json({ ok: true });
      }
      const name = clip(body.name, MAX_SHORT_FIELD);
      const email = clip(body.email, MAX_SHORT_FIELD);
      if (!name || !email) return res.status(400).json({ ok: false, reason: "Add your name and email." });
      if (!EMAIL_RE.test(email)) return res.status(400).json({ ok: false, reason: "That email address doesn't look right." });
      const source = ["forms", "systems"].includes(body.source) ? body.source : "forms";
      const record = {
        source,
        name,
        email,
        company: clip(body.company, MAX_SHORT_FIELD),
        phone: clip(body.phone, 40),
        role: clip(body.role, MAX_SHORT_FIELD),
        need: clip(body.need, MAX_LONG_FIELD),
        notes: clip(body.notes, MAX_LONG_FIELD),
        // Partners and referrals (both websites' /partners/ page and ?ref=
        // links). Anything that doesn't match is dropped, not stored.
        enquiry_type: body.enquiry_type === "partner" ? "partner" : "enquiry",
        ref: REF_RE.test(clip(body.ref, 40)) ? clip(body.ref, 40) : "",
        partner_url: /^https?:\/\/[^\s"<>]+$/.test(clip(body.partner_url, MAX_SHORT_FIELD)) ? clip(body.partner_url, MAX_SHORT_FIELD) : "",
        partner_kind: ["referral", "affiliate", "alliance"].includes(body.partner_kind) ? body.partner_kind : "",
      };
      if (record.enquiry_type !== "partner") { delete record.partner_url; delete record.partner_kind; }
      await appendJsonLine("leads.jsonl", record);
      if (leadNotificationEmailTo) {
        await sendMailBestEffort(leadNotificationEmailTo, leadNotificationEmail(record), "lead-notification");
      }
      // A plain form post (no JavaScript): send the person back to a page
      // that says it was sent, on the site they came from.
      if (req.is("application/x-www-form-urlencoded")) {
        const back = source === "systems" && leadAllowedOrigins[0] ? leadAllowedOrigins[0] : "";
        return res.redirect(303, `${back}/contact/sent/`);
      }
      res.json({ ok: true });
    },
  );

  app.get("/api/health", async (_req, res) => {
    let catalogue = null;
    try {
      const c = await loadCatalog();
      catalogue = { generated_at: c.generated_at, preview: c.preview, pricing_revision: c.pricing_revision,
        on_sale: c.packs.filter((p) => p.show && p.sellable).length };
    } catch { /* reported as null */ }
    res.json({ ok: true, service: "siteguard-forms-storefront", stripeConfigured: Boolean(stripe), stripeTestMode, catalogue });
  });

  app.use("/api", (_req, res) => res.status(404).json({ ok: false, reason: "not found" }));

  if (publicDir) {
    app.use("/assets", express.static(path.join(publicDir, "assets"), { maxAge: "1d" }));
    app.use(express.static(publicDir, { maxAge: "5m", extensions: ["html"] }));
    app.use((_req, res) => res.status(404).sendFile(path.join(publicDir, "404.html")));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error("Unhandled route error", err);
    if (err?.type === "entity.parse.failed") return res.status(400).json({ ok: false, reason: "invalid JSON" });
    if (err?.type === "entity.too.large") return res.status(413).json({ ok: false, reason: "request too large" });
    if (publicDir && !_req.path.startsWith("/api")) return res.status(500).sendFile(path.join(publicDir, "500.html"));
    res.status(500).json({ ok: false, reason: "Something went wrong. Please try again." });
  });

  return app;
}
