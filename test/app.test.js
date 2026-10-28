import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { createApp, CSP } from "../lib/create-app.js";
import { withVideoCsp } from "../scripts/lib/video.mjs";

/** A small catalogue in the shape Hseq-Dev docs/build_catalogue.py writes. */
function sampleCatalogue(over = {}) {
  return {
    schema: 1, preview: false, currency: "AUD", pricing_revision: "Rev02 -- test",
    generated_at: "2026-10-17T00:00:00+00:00",
    packs: [
      { id: "subcontractor:CARP:domestic", group: "trade-packs", name: "Carpentry Pack: Domestic", listed: true,
        sellable: true, show: true, count: 2, documents: ["SAF-SWMS-CARP-001", "SAF-SWMS-GEN-001"],
        prices: { one_off: 590, annual: 1049, monthly: 100 }, subscription_only: false },
      { id: "subcontractor:CIV:domestic", group: "trade-packs", name: "Civil Works Pack: Domestic", listed: true,
        sellable: false, show: false, count: 2, documents: ["SAF-SWMS-CIV-001", "SAF-SWMS-GEN-001"],
        prices: { one_off: 590, annual: 1049, monthly: 100 }, subscription_only: false },
      { id: "consultant:t1", group: "consultants", name: "Consultant T1", listed: true, sellable: true, show: true,
        count: 1, documents: ["SAF-SWMS-CARP-001"], prices: { one_off: null, annual: 7999, monthly: 765 }, subscription_only: true },
      { id: "swms:CARP", group: "trade-packs", name: "Carpentry SWMS Pack", listed: false, sellable: true, show: false,
        count: 2, documents: ["SAF-SWMS-CARP-001", "SAF-SWMS-GEN-001"], prices: { one_off: 590, annual: 1049, monthly: 100 } },
    ],
    documents: [
      { code: "SAF-SWMS-CARP-001", title: "General Carpentry Works", family: "SWMS", price: 49, sellable: true },
      { code: "SAF-SWMS-CIV-001", title: "Bulk Earthworks", family: "SWMS", price: 49, sellable: false },
    ],
    ...over,
  };
}

/** A fake Stripe client — no network calls, records what it was asked to do. */
function makeFakeStripe() {
  const calls = [];
  let sessionCounter = 0;
  // sessionId -> the line items that session was created with, in the same
  // shape stripe.checkout.sessions.listLineItems really returns (li.price
  // .product expanded) — the webhook handler fetches this back by session
  // id, same as it does against the real API.
  const lineItemsBySession = new Map();
  return {
    calls,
    lineItemsBySession,
    checkout: {
      sessions: {
        create: async (params) => {
          calls.push(params);
          sessionCounter += 1;
          const id = `cs_test_${sessionCounter}`;
          lineItemsBySession.set(
            id,
            // Real Stripe copies the product's *name* into the line item's
            // own description field for display — not product_data.description.
            (params.line_items ?? []).map((li) => ({
              description: li.price_data?.product_data?.name ?? null,
              amount_total: li.price_data?.unit_amount ?? null,
              price: { product: { metadata: li.price_data?.product_data?.metadata ?? {} } },
            })),
          );
          return { id, url: "https://checkout.stripe.com/test-session" };
        },
        listLineItems: async (sessionId) => ({
          data: lineItemsBySession.get(sessionId) ?? [],
        }),
      },
    },
    // Tests hand the webhook route a JSON string as the "raw" body and skip
    // real signature checking — we're testing our handler logic, not Stripe's
    // crypto.
    webhooks: {
      constructEvent: (rawBody) => JSON.parse(rawBody),
    },
  };
}

function makeFakeMailer() {
  const sent = [];
  return {
    sent,
    configured: true,
    send: async (msg) => {
      sent.push(msg);
      return { ok: true, id: `email_${sent.length}` };
    },
  };
}

/** A fake order-intake endpoint (SiteGuard-Forms' storefront-orders route). */
function makeFakeFetch({ ok = true, status = 201, body = { id: "order_1", status: "received" } } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok,
      status,
      json: async () => body,
    };
  };
  impl.calls = calls;
  return impl;
}

function stripeCustomFields({ projectAddress, clientName, siteNotes } = {}) {
  const fields = [];
  if (projectAddress !== undefined) fields.push({ key: "project_address", text: { value: projectAddress } });
  if (clientName !== undefined) fields.push({ key: "client_name", text: { value: clientName } });
  if (siteNotes !== undefined) fields.push({ key: "site_notes", text: { value: siteNotes } });
  return fields;
}


async function withApp(opts, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "forms-storefront-test-"));
  const catalogPath = path.join(dir, "catalogue.json");
  await writeFile(catalogPath, JSON.stringify(opts.catalog ?? sampleCatalogue()));
  const varDir = path.join(dir, "var");
  const app = createApp({
    catalogPath,
    varDir,
    publicDir: opts.publicDir ?? null,
    stripe: opts.stripe ?? null,
    stripeTestMode: opts.stripeTestMode ?? false,
    stripeWebhookSecret: opts.stripeWebhookSecret ?? null,
    stripeAutomaticTax: opts.stripeAutomaticTax ?? true,
    allowUnreleasedCheckout: opts.allowUnreleasedCheckout ?? false,
    publicOrigin: "http://localhost:4300",
    mailer: opts.mailer ?? { configured: false, send: async () => ({ ok: false, reason: "unconfigured" }) },
    adminNotificationEmail: opts.adminNotificationEmail,
    leadNotificationEmailTo: opts.leadNotificationEmailTo,
    leadAllowedOrigins: opts.leadAllowedOrigins ?? ["https://www.siteguardsystems.com.au"],
    orderIntakeUrl: opts.orderIntakeUrl ?? "http://intake.test/api/v3/storefront-orders",
    orderIntakeApiKey: opts.orderIntakeApiKey ?? "test-intake-key",
    fetchImpl: opts.fetchImpl ?? makeFakeFetch(),
    beta: opts.beta ?? false,
    ...(opts.csp ? { csp: opts.csp } : {}),
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, varDir, catalogPath });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

const post = (base, p, body, headers = {}) =>
  fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const checkout = (base, cart, extra = {}) => post(base, "/api/checkout", { cart, acceptedTerms: true, ...extra });

describe("headers and health", () => {
  test("security headers: CSP, HSTS, frame denial, permissions", async () => {
    await withApp({}, async ({ base }) => {
      const res = await fetch(`${base}/api/health`);
      assert.match(res.headers.get("content-security-policy"), /default-src 'self'/);
      assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/);
      assert.match(res.headers.get("strict-transport-security"), /max-age=31536000/);
      assert.equal(res.headers.get("x-frame-options"), "DENY");
      assert.ok(res.headers.get("permissions-policy"));
      assert.equal(res.headers.get("x-powered-by"), null);
      const body = await res.json();
      assert.equal(body.catalogue.on_sale, 2);
    });
  });
  test("the intro video's CSP sources are served when passed in, and not otherwise", async () => {
    await withApp({}, async ({ base }) => {
      assert.ok(!/youtube/.test((await fetch(`${base}/api/health`)).headers.get("content-security-policy")));
    });
    await withApp({ csp: withVideoCsp(CSP, { provider: "youtube", youtube_id: "dQw4w9WgXcQ" }) }, async ({ base }) => {
      const csp = (await fetch(`${base}/api/health`)).headers.get("content-security-policy");
      assert.match(csp, /frame-src 'self' https:\/\/www\.youtube-nocookie\.com/);
      assert.match(csp, /frame-ancestors 'none'/);
    });
  });
  test("unknown API routes are JSON 404s", async () => {
    await withApp({}, async ({ base }) => {
      const res = await fetch(`${base}/api/packages`);
      assert.equal(res.status, 404);
    });
  });
});

describe("POST /api/checkout", () => {
  test("refuses without accepting the terms", async () => {
    await withApp({ stripe: makeFakeStripe() }, async ({ base }) => {
      const res = await post(base, "/api/checkout", { cart: [{ packageId: "subcontractor:CARP:domestic" }] });
      assert.equal(res.status, 400);
      assert.match((await res.json()).reason, /Terms of Sale/);
    });
  });
  test("400 for an empty or oversized cart", async () => {
    await withApp({ stripe: makeFakeStripe() }, async ({ base }) => {
      assert.equal((await checkout(base, [])).status, 400);
      const big = Array.from({ length: 51 }, (_, i) => ({ documentCode: `X-${i}` }));
      assert.equal((await checkout(base, big)).status, 400);
    });
  });
  test("beta: every order is refused before Stripe is ever called", async () => {
    const stripe = makeFakeStripe();
    await withApp({ stripe, beta: true }, async ({ base }) => {
      const res = await checkout(base, [{ packageId: "subcontractor:CARP:domestic" }]);
      assert.equal(res.status, 503);
      assert.match((await res.json()).reason, /beta/);
      assert.equal(stripe.calls.length, 0);
    });
  });
  test("501 when Stripe isn't configured", async () => {
    await withApp({}, async ({ base }) => {
      assert.equal((await checkout(base, [{ packageId: "subcontractor:CARP:domestic" }])).status, 501);
    });
  });
  test("prices come from the catalogue, ex GST, with Stripe Tax and a billing address", async () => {
    const stripe = makeFakeStripe();
    await withApp({ stripe }, async ({ base }) => {
      const res = await checkout(base, [{ packageId: "subcontractor:CARP:domestic", price: 1 }, { documentCode: "SAF-SWMS-CARP-001" }],
        { termsVersion: "SG-LEGAL-02 v0.1" });
      assert.equal(res.status, 200);
      const call = stripe.calls[0];
      assert.equal(call.mode, "payment");
      assert.deepEqual(call.automatic_tax, { enabled: true });
      assert.equal(call.billing_address_collection, "required");
      assert.equal(call.line_items[0].price_data.unit_amount, 59000);
      assert.equal(call.line_items[0].price_data.tax_behavior, "exclusive");
      assert.equal(call.line_items[0].price_data.product_data.metadata.packageId, "subcontractor:CARP:domestic");
      assert.equal(call.line_items[1].price_data.unit_amount, 4900);
      assert.equal(call.line_items[1].price_data.product_data.metadata.documentCode, "SAF-SWMS-CARP-001");
      assert.equal(call.metadata.termsVersion, "SG-LEGAL-02 v0.1");
      assert.deepEqual(call.custom_fields.map((f) => f.key), ["client_name", "project_address", "site_notes"]);
      assert.equal(call.success_url, "http://localhost:4300/order/success/");
    });
  });
  test("Stripe Tax can be switched off", async () => {
    const stripe = makeFakeStripe();
    await withApp({ stripe, stripeAutomaticTax: false }, async ({ base }) => {
      await checkout(base, [{ packageId: "subcontractor:CARP:domestic" }]);
      assert.equal(stripe.calls[0].automatic_tax, undefined);
    });
  });
  test("a pack that isn't on sale, or an unlisted one, can't be bought", async () => {
    const stripe = makeFakeStripe();
    await withApp({ stripe }, async ({ base }) => {
      assert.equal((await checkout(base, [{ packageId: "subcontractor:CIV:domestic" }])).status, 409);
      assert.equal((await checkout(base, [{ packageId: "swms:CARP" }])).status, 404);
      assert.equal((await checkout(base, [{ packageId: "nope" }])).status, 404);
      assert.equal((await checkout(base, [{ documentCode: "SAF-SWMS-CIV-001" }])).status, 409);
      assert.equal(stripe.calls.length, 0);
    });
  });
  test("one bad line fails the whole cart", async () => {
    const stripe = makeFakeStripe();
    await withApp({ stripe }, async ({ base }) => {
      const res = await checkout(base, [{ packageId: "subcontractor:CARP:domestic" }, { documentCode: "NOPE" }]);
      assert.equal(res.status, 404);
      assert.equal(stripe.calls.length, 0);
    });
  });
  test("subscription-only packs go through the FORMS app, not here", async () => {
    await withApp({ stripe: makeFakeStripe() }, async ({ base }) => {
      const res = await checkout(base, [{ packageId: "consultant:t1" }]);
      assert.equal(res.status, 409);
      assert.match((await res.json()).reason, /subscription only/);
    });
  });
  test("a line can't be both a package and a document, or the same document twice", async () => {
    await withApp({ stripe: makeFakeStripe() }, async ({ base }) => {
      assert.equal((await checkout(base, [{ documentCode: "SAF-SWMS-CARP-001", packageId: "a" }])).status, 400);
      assert.equal((await checkout(base, [{ documentCode: "SAF-SWMS-CARP-001" }, { documentCode: "SAF-SWMS-CARP-001", packageId: undefined }])).status, 400);
    });
  });
  test("duplicate lines are refused", async () => {
    await withApp({ stripe: makeFakeStripe() }, async ({ base }) => {
      const res = await checkout(base, [{ documentCode: "SAF-SWMS-CARP-001" }, { documentCode: "SAF-SWMS-CARP-001" }]);
      assert.equal(res.status, 400);
    });
  });
  test("a preview catalogue never takes payment", async () => {
    await withApp({ stripe: makeFakeStripe(), catalog: sampleCatalogue({ preview: true }) }, async ({ base }) => {
      assert.equal((await checkout(base, [{ packageId: "subcontractor:CARP:domestic" }])).status, 409);
    });
  });
  test("unreleased packs can be test-bought only with a TEST key and the flag", async () => {
    await withApp({ stripe: makeFakeStripe(), stripeTestMode: true, allowUnreleasedCheckout: true }, async ({ base }) => {
      assert.equal((await checkout(base, [{ packageId: "subcontractor:CIV:domestic" }])).status, 200);
    });
    await withApp({ stripe: makeFakeStripe(), stripeTestMode: false, allowUnreleasedCheckout: true }, async ({ base }) => {
      assert.equal((await checkout(base, [{ packageId: "subcontractor:CIV:domestic" }])).status, 409);
    });
  });
  test("502 without crashing when Stripe rejects the session", async () => {
    const stripe = makeFakeStripe();
    stripe.checkout.sessions.create = async () => { throw new Error("boom"); };
    await withApp({ stripe }, async ({ base }) => {
      assert.equal((await checkout(base, [{ packageId: "subcontractor:CARP:domestic" }])).status, 502);
      assert.equal((await fetch(`${base}/api/health`)).status, 200);
    });
  });
  test("rate limited", async () => {
    await withApp({ stripe: makeFakeStripe() }, async ({ base }) => {
      let last;
      for (let i = 0; i < 21; i++) last = await checkout(base, [{ packageId: "subcontractor:CARP:domestic" }]);
      assert.equal(last.status, 429);
    });
  });
});

describe("POST /api/webhook/stripe", () => {
  async function completeOrder(base, stripe, cart, eventId = "evt_1", over = {}) {
    if (cart) await checkout(base, cart);
    const session = {
      id: `cs_test_${stripe.calls.length}`, amount_total: 69000, currency: "aud", payment_status: "paid",
      customer_details: { email: "buyer@example.com" }, total_details: { amount_tax: 6900 },
      metadata: { termsVersion: "SG-LEGAL-02 v0.1" },
      custom_fields: stripeCustomFields({ projectAddress: "1 Example St, Melbourne", clientName: "Acme Carpentry" }),
    };
    return fetch(`${base}/api/webhook/stripe`, {
      method: "POST", headers: { "Content-Type": "application/json", "stripe-signature": "t" },
      body: JSON.stringify({ id: eventId, type: over.type ?? "checkout.session.completed", data: { object: { ...session, ...over.session } } }),
    });
  }
  test("each line goes to the FORMS intake (packs by id, documents as doc:CODE) and the buyer gets a receipt", async () => {
    const stripe = makeFakeStripe();
    const fetchImpl = makeFakeFetch();
    const mailer = makeFakeMailer();
    await withApp({ stripe, stripeWebhookSecret: "whsec", fetchImpl, mailer, adminNotificationEmail: "dan@example.com" }, async ({ base, varDir }) => {
      const res = await completeOrder(base, stripe, [{ packageId: "subcontractor:CARP:domestic" }, { documentCode: "SAF-SWMS-CARP-001" }]);
      assert.equal(res.status, 200);
      const bodies = fetchImpl.calls.map((c) => JSON.parse(c.init.body));
      assert.deepEqual(bodies.map((b) => b.packageId), ["subcontractor:CARP:domestic", "doc:SAF-SWMS-CARP-001"]);
      // one intake record per line, each idempotent on its own key
      assert.deepEqual(bodies.map((b) => b.stripeSessionId), ["cs_test_1:subcontractor:CARP:domestic", "cs_test_1:doc:SAF-SWMS-CARP-001"]);
      assert.equal(bodies[0].clientName, "Acme Carpentry");
      assert.equal(fetchImpl.calls[0].init.headers["x-storefront-api-key"], "test-intake-key");
      assert.deepEqual(mailer.sent.map((m) => m.to), ["buyer@example.com", "dan@example.com"]);
      const orders = (await readFile(path.join(varDir, "orders.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
      assert.equal(orders[0].amountTax, 6900);
      assert.equal(orders[0].termsVersion, "SG-LEGAL-02 v0.1");
    });
  });
  test("a redelivered event is not processed twice", async () => {
    const stripe = makeFakeStripe();
    const fetchImpl = makeFakeFetch();
    await withApp({ stripe, stripeWebhookSecret: "whsec", fetchImpl }, async ({ base }) => {
      await completeOrder(base, stripe, [{ packageId: "subcontractor:CARP:domestic" }], "evt_dup");
      const again = await completeOrder(base, stripe, null, "evt_dup");
      assert.equal((await again.json()).duplicate, true);
      assert.equal(fetchImpl.calls.length, 1);
    });
  });
  test("an unpaid session is not fulfilled until the payment succeeds", async () => {
    const stripe = makeFakeStripe();
    const fetchImpl = makeFakeFetch();
    await withApp({ stripe, stripeWebhookSecret: "whsec", fetchImpl }, async ({ base }) => {
      const r1 = await completeOrder(base, stripe, [{ packageId: "subcontractor:CARP:domestic" }], "evt_a", { session: { payment_status: "unpaid" } });
      assert.equal((await r1.json()).awaitingPayment, true);
      assert.equal(fetchImpl.calls.length, 0);
      await completeOrder(base, stripe, null, "evt_b", { type: "checkout.session.async_payment_succeeded" });
      assert.equal(fetchImpl.calls.length, 1);
      // the completed event arriving again later does not fulfil twice
      await completeOrder(base, stripe, null, "evt_c");
      assert.equal(fetchImpl.calls.length, 1);
    });
  });
  test("if Stripe can't list the items, answer 500 so Stripe retries, and the retry fulfils", async () => {
    const stripe = makeFakeStripe();
    const fetchImpl = makeFakeFetch();
    const real = stripe.checkout.sessions.listLineItems;
    let fail = true;
    stripe.checkout.sessions.listLineItems = async (id, o) => { if (fail) throw new Error("stripe down"); return real(id, o); };
    await withApp({ stripe, stripeWebhookSecret: "whsec", fetchImpl }, async ({ base }) => {
      const r1 = await completeOrder(base, stripe, [{ packageId: "subcontractor:CARP:domestic" }], "evt_x");
      assert.equal(r1.status, 500);
      assert.equal(fetchImpl.calls.length, 0);
      fail = false;
      const r2 = await completeOrder(base, stripe, null, "evt_x");
      assert.equal(r2.status, 200);
      assert.equal(fetchImpl.calls.length, 1);
    });
  });
  test("an intake outage answers 500 before any email, so the retry is clean", async () => {
    const stripe = makeFakeStripe();
    const mailer = makeFakeMailer();
    const down = makeFakeFetch({ ok: false, status: 503, body: {} });
    await withApp({ stripe, stripeWebhookSecret: "whsec", fetchImpl: down, mailer }, async ({ base }) => {
      const r = await completeOrder(base, stripe, [{ packageId: "subcontractor:CARP:domestic" }], "evt_y");
      assert.equal(r.status, 500);
      assert.equal(mailer.sent.length, 0);
    });
  });
  test("a bad signature is rejected, and alerts Dan once", async () => {
    const stripe = makeFakeStripe();
    stripe.webhooks.constructEvent = () => { throw new Error("bad sig"); };
    const mailer = makeFakeMailer();
    await withApp({ stripe, stripeWebhookSecret: "whsec", mailer, adminNotificationEmail: "dan@siteguardsystems.com.au" }, async ({ base }) => {
      const post = () => fetch(`${base}/api/webhook/stripe`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const res = await post();
      assert.equal(res.status, 400);
      assert.equal(mailer.sent.length, 1, "one alert for the first failure");
      assert.match(mailer.sent[0].subject, /signature check failed/i);
      assert.equal(mailer.sent[0].to, "dan@siteguardsystems.com.au");
      // A second failure within the hour is rate-limited, not a second email.
      await post();
      assert.equal(mailer.sent.length, 1, "rate-limited to one alert per hour");
    });
  });
  test("501 when the webhook isn't configured", async () => {
    await withApp({}, async ({ base }) => {
      assert.equal((await fetch(`${base}/api/webhook/stripe`, { method: "POST", body: "{}" })).status, 501);
    });
  });
});

describe("POST /api/lead", () => {
  test("validates name and email", async () => {
    await withApp({}, async ({ base }) => {
      assert.equal((await post(base, "/api/lead", { email: "a@b.co" })).status, 400);
      assert.equal((await post(base, "/api/lead", { name: "A", email: "nope" })).status, 400);
    });
  });
  test("stores the enquiry with its source and emails it", async () => {
    const mailer = makeFakeMailer();
    await withApp({ mailer, leadNotificationEmailTo: "dan@example.com" }, async ({ base, varDir }) => {
      const res = await post(base, "/api/lead", { source: "systems", name: " Sam ", email: "sam@example.com", phone: "0400 000 000", need: "ISO 45001" });
      assert.equal(res.status, 200);
      const lead = JSON.parse((await readFile(path.join(varDir, "leads.jsonl"), "utf8")).trim());
      assert.equal(lead.name, "Sam");
      assert.equal(lead.source, "systems");
      assert.equal(mailer.sent[0].to, "dan@example.com");
      assert.match(mailer.sent[0].subject, /Sam/);
    });
  });
  test("a partner application keeps its partner fields and referral code, and says so in the email", async () => {
    const mailer = makeFakeMailer();
    await withApp({ mailer, leadNotificationEmailTo: "dan@example.com" }, async ({ base, varDir }) => {
      const res = await post(base, "/api/lead", { source: "systems", name: "Pat", email: "pat@broker.example", company: "Pat Brokers",
        need: "We insure builders", enquiry_type: "partner", partner_kind: "referral", partner_url: "https://broker.example", ref: "ACME-01" });
      assert.equal(res.status, 200);
      const lead = JSON.parse((await readFile(path.join(varDir, "leads.jsonl"), "utf8")).trim());
      assert.equal(lead.enquiry_type, "partner");
      assert.equal(lead.partner_kind, "referral");
      assert.equal(lead.partner_url, "https://broker.example");
      assert.equal(lead.ref, "ACME-01");
      assert.match(mailer.sent[0].subject, /^Website enquiry — Partner application — Pat/);
      assert.match(mailer.sent[0].text, /^New enquiry from siteguardsystems\.com\.au/);
      assert.match(mailer.sent[0].text, /Referral code: ACME-01/);
      assert.match(mailer.sent[0].text, /Enquiry type: Partner application/);
    });
  });
  test("bad partner fields and referral codes are dropped, an ordinary enquiry keeps its referral code", async () => {
    await withApp({}, async ({ base, varDir }) => {
      await post(base, "/api/lead", { name: "A", email: "a@b.co", need: "x", enquiry_type: "sponsor", partner_url: "javascript:alert(1)",
        partner_kind: "boss", ref: "bad code!" });
      await post(base, "/api/lead", { name: "B", email: "b@b.co", need: "x", ref: "ACME" });
      const [a, b] = (await readFile(path.join(varDir, "leads.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
      assert.equal(a.enquiry_type, "enquiry");
      assert.equal(a.ref, "");
      assert.equal(a.partner_url, undefined);
      assert.equal(a.partner_kind, undefined);
      assert.equal(b.ref, "ACME");
    });
  });
  test("the honeypot keeps nothing but answers ok", async () => {
    await withApp({}, async ({ base, varDir }) => {
      const res = await post(base, "/api/lead", { name: "Bot", email: "bot@example.com", website: "http://spam" });
      assert.equal(res.status, 200);
      await assert.rejects(readFile(path.join(varDir, "leads.jsonl"), "utf8"));
    });
  });
  test("CORS only for the SiteGuard Systems site", async () => {
    await withApp({}, async ({ base }) => {
      const ok = await fetch(`${base}/api/lead`, { method: "OPTIONS", headers: { Origin: "https://www.siteguardsystems.com.au" } });
      assert.equal(ok.status, 204);
      assert.equal(ok.headers.get("access-control-allow-origin"), "https://www.siteguardsystems.com.au");
      const bad = await fetch(`${base}/api/lead`, { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
      assert.equal(bad.status, 403);
      const post2 = await post(base, "/api/lead", { name: "A", email: "a@b.co" }, { Origin: "https://evil.example" });
      assert.equal(post2.headers.get("access-control-allow-origin"), null);
    });
  });
  test("a plain form post (no JavaScript) is accepted and redirected to the sent page", async () => {
    await withApp({}, async ({ base, varDir }) => {
      const res = await fetch(`${base}/api/lead`, { method: "POST", redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ source: "systems", name: "Sam", email: "sam@example.com", need: "x" }) });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get("location"), "https://www.siteguardsystems.com.au/contact/sent/");
      assert.match(await readFile(path.join(varDir, "leads.jsonl"), "utf8"), /sam@example.com/);
    });
  });
  test("rate limited after 5 in 10 minutes", async () => {
    await withApp({}, async ({ base }) => {
      let last;
      for (let i = 0; i < 6; i++) last = await post(base, "/api/lead", { name: "A", email: "a@b.co" });
      assert.equal(last.status, 429);
    });
  });
});
