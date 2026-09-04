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
  return {
    calls,
    checkout: {
      sessions: {
        create: async (params) => {
          calls.push(params);
          sessionCounter += 1;
          return {
            id: `cs_test_${sessionCounter}`,
            url: "https://checkout.stripe.com/test-session",
          };
        },
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
  const catalogPath = path.join(dir, "packages.json");
  await writeFile(catalogPath, JSON.stringify(opts.catalog ?? SAMPLE_CATALOG));
  const varDir = path.join(dir, "var");

  const app = createApp({
    catalogPath,
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
      assert.equal(call.metadata.packageId, "single-swms");
      assert.equal(call.line_items[0].price_data.unit_amount, 14900);
      assert.equal(call.success_url, "http://localhost:4300/?checkout=success&package=single-swms");

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
      assert.equal(call.metadata.option, "iso-ofsc");
      assert.equal(call.metadata.packageId, "rung-picker-item");
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
});

describe("POST /api/webhook/stripe — order intake", () => {
  test("checkout.session.completed records the order for review and emails the customer", async () => {
    const stripe = makeFakeStripe();
    const mailer = makeFakeMailer();
    const fetchImpl = makeFakeFetch();
    await withApp(
      { stripe, mailer, fetchImpl, stripeWebhookSecret: "whsec_test" },
      async ({ base, varDir }) => {
        const event = {
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_1",
              mode: "payment",
              customer: "cus_a",
              customer_details: { email: "buyer@example.com" },
              amount_total: 24900,
              currency: "aud",
              metadata: { packageId: "registers-bundle", packageName: "Registers Bundle" },
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

  test("still logs the order locally even if order intake is unreachable", async () => {
    const stripe = makeFakeStripe();
    const fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    await withApp({ stripe, fetchImpl, stripeWebhookSecret: "whsec_test" }, async ({ base, varDir }) => {
      const event = {
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_down",
            mode: "payment",
            customer: "cus_b",
            customer_details: { email: "buyer2@example.com" },
            metadata: { packageId: "single-swms", packageName: "Single SWMS" },
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
