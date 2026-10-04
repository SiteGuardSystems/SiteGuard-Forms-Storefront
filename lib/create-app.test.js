import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { createApp } from "./create-app.js";

const SAMPLE_CATALOG = {
  currency: "aud",
  categories: [
    {
      id: "registers",
      name: "Registers",
      items: [
        {
          id: "single-swms",
          tier: "self-serve",
          name: "Single SWMS",
          tagline: "One controlled SWMS",
          unit_amount: 14900,
        },
        {
          id: "rung-picker-item",
          tier: "self-serve",
          name: "Test Trade Pack",
          tagline: "base tagline (never charged — every rung sets its own)",
          purchaseOptions: {
            domestic: { unit_amount: 44900, name: "Test Trade Pack — Domestic", tagline: "Domestic rung" },
            "iso-ofsc": { unit_amount: 449900, name: "Test Trade Pack — ISO/OFSC", tagline: "ISO/OFSC rung" },
            "heavy-commercial": { tier: "quote", name: "Test Trade Pack — Heavy Commercial" },
          },
        },
      ],
    },
    {
      id: "management-systems",
      name: "Management Systems",
      items: [
        {
          id: "ims-quote",
          tier: "quote",
          name: "ISO / IMS Framework",
          tagline: "Scoped before checkout",
        },
      ],
    },
    {
      id: "swms",
      name: "SWMS",
      items: [{ id: "swms-roofing", trade: "Roofing" }],
      _itemDefaults: { tier: "coming-soon", cta: "Notify Me" },
    },
  ],
};

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

const SAMPLE_DOCUMENTS = [
  { code: "SAF-SWMS-CARP-001", title: "General Carpentry Works", kind: "SWMS" },
  { code: "QUA-ITP-CONC-005", title: "Concrete Placement ITP", kind: "ITP" },
];

async function withApp(opts, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "forms-storefront-test-"));
  const catalogPath = path.join(dir, "packages.json");
  await writeFile(catalogPath, JSON.stringify(opts.catalog ?? SAMPLE_CATALOG));
  const individualDocsPath = path.join(dir, "individual-documents.json");
  await writeFile(individualDocsPath, JSON.stringify(opts.documents ?? SAMPLE_DOCUMENTS));
  const varDir = path.join(dir, "var");

  const app = createApp({
    catalogPath,
    individualDocsPath,
    varDir,
    publicDir: null,
    stripe: opts.stripe ?? null,
    stripeTestMode: opts.stripeTestMode ?? false,
    stripeWebhookSecret: opts.stripeWebhookSecret ?? null,
    publicOrigin: "http://localhost:4300",
    mailer: opts.mailer ?? { configured: false, send: async () => ({ ok: false, reason: "unconfigured" }) },
    orderIntakeUrl: opts.orderIntakeUrl ?? "http://intake.test/api/v3/storefront-orders",
    orderIntakeApiKey: opts.orderIntakeApiKey ?? "test-intake-key",
    fetchImpl: opts.fetchImpl ?? makeFakeFetch(),
  });

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    await fn({ base, varDir });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

describe("GET /api/health", () => {
  test("reports stripeConfigured false when no Stripe client", async () => {
    await withApp({}, async ({ base }) => {
      const res = await fetch(`${base}/api/health`);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.stripeConfigured, false);
    });
  });

  test("sets basic hardening headers", async () => {
    await withApp({}, async ({ base }) => {
      const res = await fetch(`${base}/api/health`);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.equal(res.headers.get("x-frame-options"), "DENY");
    });
  });
});

describe("GET /api/packages", () => {
  test("returns the categorised catalog plus stripe flags", async () => {
    await withApp({ stripe: makeFakeStripe(), stripeTestMode: true }, async ({ base }) => {
      const res = await fetch(`${base}/api/packages`);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.categories.length, 3);
      assert.equal(body.stripeConfigured, true);
      assert.equal(body.stripeTestMode, true);
      // _itemDefaults isn't resolved server-side for display — the client
      // merges it per-item so a category can define it once for many items.
      assert.equal(body.categories[2].items[0].trade, "Roofing");
    });
  });
});

describe("POST /api/checkout", () => {
  test("400 when packageId missing", async () => {
    await withApp({}, async ({ base }) => {
      const res = await fetch(`${base}/api/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
    });
  });

  test("404 for an unknown packageId", async () => {
    await withApp({ stripe: makeFakeStripe() }, async ({ base }) => {
      const res = await fetch(`${base}/api/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageId: "does-not-exist" }),
      });
      assert.equal(res.status, 404);
    });
  });

  test("409 for a quote-tier package (no self-serve checkout)", async () => {
    await withApp({ stripe: makeFakeStripe() }, async ({ base }) => {
      const res = await fetch(`${base}/api/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageId: "ims-quote" }),
      });
      assert.equal(res.status, 409);
    });
  });

  test("409 for a coming-soon item (via category _itemDefaults)", async () => {
    await withApp({ stripe: makeFakeStripe() }, async ({ base }) => {
      const res = await fetch(`${base}/api/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageId: "swms-roofing" }),
      });
      assert.equal(res.status, 409);
    });
  });

  test("501 when Stripe isn't configured", async () => {
    await withApp({ stripe: null }, async ({ base }) => {
      const res = await fetch(`${base}/api/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageId: "single-swms" }),
      });
      assert.equal(res.status, 501);
    });
  });

  test("creates a one-off payment session collecting project details via Stripe custom_fields", async () => {
    const stripe = makeFakeStripe();
    await withApp({ stripe }, async ({ base }) => {
      const res = await fetch(`${base}/api/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageId: "single-swms" }),
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.url, "https://checkout.stripe.com/test-session");

      assert.equal(stripe.calls.length, 1);
      const call = stripe.calls[0];
      assert.equal(call.mode, "payment"); // never "subscription" — see ORDER_SITE.md
      assert.equal(call.customer_creation, "always");
      assert.equal(call.line_items[0].price_data.product_data.metadata.packageId, "single-swms");
      assert.equal(call.line_items[0].price_data.unit_amount, 14900);
      assert.equal(call.success_url, "http://localhost:4300/?checkout=success");

      const keys = call.custom_fields.map((f) => f.key);
      assert.deepEqual(keys, ["project_address", "client_name", "site_notes"]);
      assert.equal(call.custom_fields.find((f) => f.key === "site_notes").optional, true);
      // Stripe rejects any custom_fields text.maximum_length over 255 — this
      // crashed the whole process once (project_address was 500). Guard it.
      for (const field of call.custom_fields) {
        assert.ok(field.text.maximum_length <= 255, `${field.key} exceeds Stripe's 255-char cap`);
      }
    });
  });

  test("a purchaseOptions item charges the selected option's price, not the item's own", async () => {
    const stripe = makeFakeStripe();
    await withApp({ stripe }, async ({ base }) => {
      const res = await fetch(`${base}/api/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageId: "rung-picker-item", option: "iso-ofsc" }),
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.ok, true);

      const call = stripe.calls[0];
      // 449900 (the iso-ofsc option), not the item's own tagline/unit_amount
      // (it has none — every price lives on the option).
      assert.equal(call.line_items[0].price_data.unit_amount, 449900);
      assert.equal(call.line_items[0].price_data.product_data.name, "Test Trade Pack — ISO/OFSC");
      assert.equal(call.line_items[0].price_data.product_data.metadata.option, "iso-ofsc");
      assert.equal(call.line_items[0].price_data.product_data.metadata.packageId, "rung-picker-item");
    });
  });

  test("400 when a purchaseOptions item is checked out without an option", async () => {
    await withApp({ stripe: makeFakeStripe() }, async ({ base }) => {
      const res = await fetch(`${base}/api/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageId: "rung-picker-item" }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.reason, /option is required/);
    });
  });

  test("400 when the selected option doesn't exist on the item", async () => {
    await withApp({ stripe: makeFakeStripe() }, async ({ base }) => {
      const res = await fetch(`${base}/api/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageId: "rung-picker-item", option: "does-not-exist" }),
      });
      assert.equal(res.status, 400);
    });
  });

  test("409 when the selected option's own tier is quote, even though the item's base tier is self-serve", async () => {
    await withApp({ stripe: makeFakeStripe() }, async ({ base }) => {
      const res = await fetch(`${base}/api/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageId: "rung-picker-item", option: "heavy-commercial" }),
      });
      assert.equal(res.status, 409);
    });
  });

  test("502s (without crashing) when Stripe rejects the session", async () => {
    const stripe = makeFakeStripe();
    stripe.checkout.sessions.create = async () => {
      throw new Error("StripeInvalidRequestError: simulated");
    };
    await withApp({ stripe }, async ({ base }) => {
      const res = await fetch(`${base}/api/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageId: "single-swms" }),
      });
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.ok, false);
    });
  });

  test("a cart of multiple packages becomes one session with one line item each", async () => {
    const stripe = makeFakeStripe();
    await withApp({ stripe }, async ({ base }) => {
      const res = await fetch(`${base}/api/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cart: [{ packageId: "single-swms" }, { packageId: "rung-picker-item", option: "domestic" }],
        }),
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.ok, true);

      // One Stripe session, not two separate checkouts.
      assert.equal(stripe.calls.length, 1);
      const call = stripe.calls[0];
      assert.equal(call.line_items.length, 2);
      assert.equal(call.line_items[0].price_data.unit_amount, 14900);
      assert.equal(call.line_items[1].price_data.unit_amount, 44900);
      assert.equal(call.line_items[1].price_data.product_data.metadata.option, "domestic");
    });
  });

  test("a cart entry can be a single document at the flat per-document rate", async () => {
    const stripe = makeFakeStripe();
    await withApp({ stripe }, async ({ base }) => {
      const res = await fetch(`${base}/api/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cart: [{ documentCode: "SAF-SWMS-CARP-001" }] }),
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.ok, true);

      const call = stripe.calls[0];
      assert.equal(call.line_items[0].price_data.unit_amount, 4900);
      assert.equal(call.line_items[0].price_data.product_data.metadata.documentCode, "SAF-SWMS-CARP-001");
      assert.match(call.line_items[0].price_data.product_data.name, /General Carpentry Works/);
    });
  });

  test("404 for an unknown document code, and the whole cart fails with it", async () => {
    await withApp({ stripe: makeFakeStripe() }, async ({ base }) => {
      const res = await fetch(`${base}/api/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cart: [{ packageId: "single-swms" }, { documentCode: "DOES-NOT-EXIST-001" }],
        }),
      });
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.match(body.reason, /unknown document code/);
    });
  });

  test("400 when the cart exceeds the item limit", async () => {
    await withApp({ stripe: makeFakeStripe() }, async ({ base }) => {
      const cart = Array.from({ length: 51 }, () => ({ packageId: "single-swms" }));
      const res = await fetch(`${base}/api/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cart }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.reason, /limited to/);
    });
  });

  test("400 for an empty cart", async () => {
    await withApp({ stripe: makeFakeStripe() }, async ({ base }) => {
      const res = await fetch(`${base}/api/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cart: [] }),
      });
      assert.equal(res.status, 400);
    });
  });
});

describe("GET /api/documents", () => {
  test("returns the individual-document catalog with the flat unit price", async () => {
    await withApp({}, async ({ base }) => {
      const res = await fetch(`${base}/api/documents`);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.unitAmount, 4900);
      assert.equal(body.documents.length, 2);
      assert.equal(body.documents[0].code, "SAF-SWMS-CARP-001");
    });
  });
});

describe("POST /api/webhook/stripe — order intake", () => {
  test("checkout.session.completed records the order for review and emails the customer", async () => {
    const stripe = makeFakeStripe();
    const mailer = makeFakeMailer();
    const fetchImpl = makeFakeFetch();
    // The webhook handler fetches line items back by session id (the event
    // payload itself never carries them) — pre-populate what a real
    // checkout.sessions.create would have stored for this session.
    stripe.lineItemsBySession.set("cs_1", [
      {
        description: "Registers Bundle",
        amount_total: 24900,
        price: { product: { metadata: { packageId: "registers-bundle" } } },
      },
    ]);
    await withApp(
      { stripe, mailer, fetchImpl, stripeWebhookSecret: "whsec_test" },
      async ({ base, varDir }) => {
        const event = {
          id: "evt_1",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_1",
              mode: "payment",
              customer: "cus_a",
              customer_details: { email: "buyer@example.com" },
              amount_total: 24900,
              currency: "aud",
              custom_fields: stripeCustomFields({
                projectAddress: "1 Test St, Melbourne",
                clientName: "Acme Pty Ltd",
                siteNotes: "Site access via rear laneway",
              }),
            },
          },
        };
        const res = await fetch(`${base}/api/webhook/stripe`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "stripe-signature": "irrelevant-in-tests" },
          body: JSON.stringify(event),
        });
        assert.equal(res.status, 200);

        assert.equal(fetchImpl.calls.length, 1);
        const [{ url, init }] = fetchImpl.calls;
        assert.equal(url, "http://intake.test/api/v3/storefront-orders");
        assert.equal(init.headers["x-storefront-api-key"], "test-intake-key");
        const sent = JSON.parse(init.body);
        assert.equal(sent.packageId, "registers-bundle");
        assert.equal(sent.stripeSessionId, "cs_1");
        assert.equal(sent.customerEmail, "buyer@example.com");
        assert.equal(sent.projectAddress, "1 Test St, Melbourne");
        assert.equal(sent.clientName, "Acme Pty Ltd");
        assert.equal(sent.siteNotes, "Site access via rear laneway");

        assert.equal(mailer.sent.length, 1);
        assert.equal(mailer.sent[0].to, "buyer@example.com");
        assert.ok(mailer.sent[0].html.includes("1 Test St, Melbourne"));

        const orderLog = (await readFile(path.join(varDir, "orders.jsonl"), "utf8")).trim().split("\n");
        assert.equal(orderLog.length, 1);
        assert.equal(JSON.parse(orderLog[0]).sessionId, "cs_1");

        const notifyLog = JSON.parse(
          (await readFile(path.join(varDir, "order-notify-events.jsonl"), "utf8")).trim(),
        );
        assert.equal(notifyLog.ok, true);
        assert.equal(notifyLog.body.status, "received");
      },
    );
  });

  test("a redelivered webhook (same event id) does not reprocess the order", async () => {
    // Stripe explicitly documents at-least-once delivery -- a webhook can
    // arrive twice for the same event even with no error on either side.
    const stripe = makeFakeStripe();
    const mailer = makeFakeMailer();
    const fetchImpl = makeFakeFetch();
    stripe.lineItemsBySession.set("cs_dupe", [
      {
        description: "Registers Bundle",
        amount_total: 24900,
        price: { product: { metadata: { packageId: "registers-bundle" } } },
      },
    ]);
    await withApp(
      { stripe, mailer, fetchImpl, stripeWebhookSecret: "whsec_test" },
      async ({ base, varDir }) => {
        const event = {
          id: "evt_dupe",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_dupe",
              mode: "payment",
              customer: "cus_dupe",
              customer_details: { email: "dupe@example.com" },
              amount_total: 24900,
              currency: "aud",
              custom_fields: stripeCustomFields({
                projectAddress: "1 Dupe St, Melbourne",
                clientName: "Dupe Pty Ltd",
              }),
            },
          },
        };
        const post = () =>
          fetch(`${base}/api/webhook/stripe`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "stripe-signature": "irrelevant-in-tests" },
            body: JSON.stringify(event),
          });

        const first = await post();
        assert.equal(first.status, 200);
        assert.equal((await first.json()).duplicate, undefined);

        const second = await post();
        assert.equal(second.status, 200);
        assert.equal((await second.json()).duplicate, true);

        // The real-work side effects happened exactly once, not twice.
        assert.equal(fetchImpl.calls.length, 1);
        assert.equal(mailer.sent.length, 1);
        const orderLog = (await readFile(path.join(varDir, "orders.jsonl"), "utf8")).trim().split("\n");
        assert.equal(orderLog.length, 1);
      },
    );
  });

  test("a multi-item cart notifies order intake once per item and emails one combined receipt", async () => {
    const stripe = makeFakeStripe();
    const mailer = makeFakeMailer();
    const fetchImpl = makeFakeFetch();
    stripe.lineItemsBySession.set("cs_cart", [
      {
        description: "Registers Bundle",
        amount_total: 24900,
        price: { product: { metadata: { packageId: "registers-bundle" } } },
      },
      {
        description: "SAF-SWMS-CARP-001 — General Carpentry Works",
        amount_total: 4900,
        price: { product: { metadata: { documentCode: "SAF-SWMS-CARP-001" } } },
      },
    ]);
    await withApp(
      { stripe, mailer, fetchImpl, stripeWebhookSecret: "whsec_test" },
      async ({ base, varDir }) => {
        const event = {
          id: "evt_cart",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_cart",
              mode: "payment",
              customer: "cus_c",
              customer_details: { email: "buyer3@example.com" },
              amount_total: 29800,
              currency: "aud",
              custom_fields: stripeCustomFields({
                projectAddress: "3 Test St, Melbourne",
                clientName: "Gamma Pty Ltd",
              }),
            },
          },
        };
        const res = await fetch(`${base}/api/webhook/stripe`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "stripe-signature": "irrelevant-in-tests" },
          body: JSON.stringify(event),
        });
        assert.equal(res.status, 200);

        // One intake call per cart item, not one for the whole order.
        assert.equal(fetchImpl.calls.length, 2);
        const sentPackageIds = fetchImpl.calls.map((c) => JSON.parse(c.init.body).packageId);
        assert.deepEqual(sentPackageIds, ["registers-bundle", "SAF-SWMS-CARP-001"]);

        const orderLog = JSON.parse(
          (await readFile(path.join(varDir, "orders.jsonl"), "utf8")).trim(),
        );
        assert.equal(orderLog.items.length, 2);

        // One email, naming both items, not two separate emails.
        assert.equal(mailer.sent.length, 1);
        assert.match(mailer.sent[0].subject, /Registers Bundle.*SAF-SWMS-CARP-001/);
      },
    );
  });

  test("still logs the order locally even if order intake is unreachable", async () => {
    const stripe = makeFakeStripe();
    const fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    stripe.lineItemsBySession.set("cs_down", [
      {
        description: "Single SWMS",
        amount_total: 14900,
        price: { product: { metadata: { packageId: "single-swms" } } },
      },
    ]);
    await withApp({ stripe, fetchImpl, stripeWebhookSecret: "whsec_test" }, async ({ base, varDir }) => {
      const event = {
        id: "evt_down",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_down",
            mode: "payment",
            customer: "cus_b",
            customer_details: { email: "buyer2@example.com" },
            custom_fields: stripeCustomFields({ projectAddress: "2 Test St", clientName: "Beta Co" }),
          },
        },
      };
      const res = await fetch(`${base}/api/webhook/stripe`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "stripe-signature": "x" },
        body: JSON.stringify(event),
      });
      // The customer's webhook ack doesn't fail just because order intake is down.
      assert.equal(res.status, 200);

      const orderLog = (await readFile(path.join(varDir, "orders.jsonl"), "utf8")).trim().split("\n");
      assert.equal(orderLog.length, 1);

      const notifyLog = JSON.parse(
        (await readFile(path.join(varDir, "order-notify-events.jsonl"), "utf8")).trim(),
      );
      assert.equal(notifyLog.ok, false);
      assert.match(notifyLog.reason, /ECONNREFUSED/);
    });
  });

  test("501 when Stripe/webhook secret isn't configured", async () => {
    await withApp({}, async ({ base }) => {
      const res = await fetch(`${base}/api/webhook/stripe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 501);
    });
  });
});

describe("POST /api/lead", () => {
  test("400 when name or email missing", async () => {
    await withApp({}, async ({ base }) => {
      const res = await fetch(`${base}/api/lead`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Jane" }),
      });
      assert.equal(res.status, 400);
    });
  });

  test("400 when the email doesn't look valid", async () => {
    await withApp({}, async ({ base }) => {
      const res = await fetch(`${base}/api/lead`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Jane", email: "not-an-email" }),
      });
      assert.equal(res.status, 400);
    });
  });

  test("accepts a valid lead, trims fields, and appends it to leads.jsonl", async () => {
    await withApp({}, async ({ base, varDir }) => {
      const res = await fetch(`${base}/api/lead`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "  Jane Smith  ",
          email: " jane@example.com ",
          company: "Acme Builders",
          role: "Subcontractor",
          need: "A trade compliance pack",
        }),
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.ok, true);

      const raw = await readFile(path.join(varDir, "leads.jsonl"), "utf8");
      const record = JSON.parse(raw.trim().split("\n").pop());
      assert.equal(record.name, "Jane Smith");
      assert.equal(record.email, "jane@example.com");
      assert.equal(record.company, "Acme Builders");
    });
  });
});
