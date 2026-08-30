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
          id: "registers-bundle",
          tier: "self-serve",
          name: "Registers Bundle",
          tagline: "18 registers",
          unit_amount: 24900,
          purchaseOptions: {
            pdf: { unit_amount: 9900, label: "PDF Only" },
            projectPack: { unit_amount: 24900, label: "Pack + 5 Projects", credits: 5 },
            subscription: { unit_amount: 19900, interval: "month", label: "Subscription", credits: 5 },
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

const TEST_MAGIC_LINK_SECRET = "test-magic-link-secret";

/** A fake Stripe client — no network calls, records what it was asked to do. */
function makeFakeStripe({ subscriptionsById = {} } = {}) {
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
    subscriptions: {
      retrieve: async (id) => subscriptionsById[id],
    },
  };
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
    magicLinkSecret: opts.magicLinkSecret ?? TEST_MAGIC_LINK_SECRET,
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

  test("creates a Stripe Checkout session for a self-serve package", async () => {
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
      assert.equal(call.mode, "payment");
      assert.equal(call.metadata.packageId, "single-swms");
      assert.equal(call.line_items[0].price_data.unit_amount, 14900);
      assert.equal(call.success_url, "http://localhost:4300/?checkout=success&package=single-swms");
    });
  });

  test("400 for an option that doesn't exist on this package", async () => {
    await withApp({ stripe: makeFakeStripe() }, async ({ base }) => {
      const res = await fetch(`${base}/api/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageId: "registers-bundle", option: "not-a-real-option" }),
      });
      assert.equal(res.status, 400);
    });
  });

  test("option=pdf: one-time payment, no credits metadata", async () => {
    const stripe = makeFakeStripe();
    await withApp({ stripe }, async ({ base }) => {
      const res = await fetch(`${base}/api/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageId: "registers-bundle", option: "pdf" }),
      });
      assert.equal(res.status, 200);
      const call = stripe.calls[0];
      assert.equal(call.mode, "payment");
      assert.equal(call.customer_creation, "always");
      assert.equal(call.line_items[0].price_data.unit_amount, 9900);
      assert.equal(call.metadata.credits, "0");
    });
  });

  test("option=projectPack: one-time payment carrying credits in metadata", async () => {
    const stripe = makeFakeStripe();
    await withApp({ stripe }, async ({ base }) => {
      const res = await fetch(`${base}/api/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageId: "registers-bundle", option: "projectPack" }),
      });
      assert.equal(res.status, 200);
      const call = stripe.calls[0];
      assert.equal(call.mode, "payment");
      assert.equal(call.line_items[0].price_data.unit_amount, 24900);
      assert.equal(call.metadata.packageId, "registers-bundle");
      assert.equal(call.metadata.option, "projectPack");
      assert.equal(call.metadata.credits, "5");
    });
  });

  test("option=subscription: recurring mode with subscription_data.metadata", async () => {
    const stripe = makeFakeStripe();
    await withApp({ stripe }, async ({ base }) => {
      const res = await fetch(`${base}/api/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageId: "registers-bundle", option: "subscription" }),
      });
      assert.equal(res.status, 200);
      const call = stripe.calls[0];
      assert.equal(call.mode, "subscription");
      assert.equal(call.customer_creation, undefined); // not valid for subscription mode
      assert.equal(call.line_items[0].price_data.unit_amount, 19900);
      assert.equal(call.line_items[0].price_data.recurring.interval, "month");
      assert.equal(call.subscription_data.metadata.credits, "5");
      assert.equal(call.subscription_data.metadata.packageId, "registers-bundle");
    });
  });
});

describe("POST /api/webhook/stripe — credit granting", () => {
  test("checkout.session.completed with option=projectPack grants credits and logs a magic link", async () => {
    const stripe = makeFakeStripe();
    await withApp({ stripe, stripeWebhookSecret: "whsec_test" }, async ({ base, varDir }) => {
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
            metadata: { packageId: "registers-bundle", option: "projectPack", credits: "5" },
          },
        },
      };
      const res = await fetch(`${base}/api/webhook/stripe`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "stripe-signature": "irrelevant-in-tests" },
        body: JSON.stringify(event),
      });
      assert.equal(res.status, 200);

      const balances = JSON.parse(await readFile(path.join(varDir, "credit-balances.json"), "utf8"));
      assert.equal(balances.cus_a.packages["registers-bundle"], 5);

      const links = (await readFile(path.join(varDir, "magic-links.jsonl"), "utf8")).trim().split("\n");
      assert.equal(links.length, 1);
      const link = JSON.parse(links[0]);
      assert.equal(link.stripeCustomerId, "cus_a");
      assert.ok(link.redeemUrl.startsWith("http://localhost:4300/redeem?token="));
    });
  });

  test("invoice.paid for a subscription_cycle renewal grants another round of credits", async () => {
    const stripe = makeFakeStripe({
      subscriptionsById: {
        sub_1: { metadata: { packageId: "registers-bundle", credits: "5" } },
      },
    });
    await withApp({ stripe, stripeWebhookSecret: "whsec_test" }, async ({ base, varDir }) => {
      const event = {
        type: "invoice.paid",
        data: {
          object: {
            id: "in_1",
            billing_reason: "subscription_cycle",
            subscription: "sub_1",
            customer: "cus_b",
            customer_email: "renewer@example.com",
          },
        },
      };
      const res = await fetch(`${base}/api/webhook/stripe`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "stripe-signature": "irrelevant-in-tests" },
        body: JSON.stringify(event),
      });
      assert.equal(res.status, 200);
      const balances = JSON.parse(await readFile(path.join(varDir, "credit-balances.json"), "utf8"));
      assert.equal(balances.cus_b.packages["registers-bundle"], 5);
    });
  });

  test("redelivering the same checkout.session.completed event does not double-grant", async () => {
    const stripe = makeFakeStripe();
    await withApp({ stripe, stripeWebhookSecret: "whsec_test" }, async ({ base, varDir }) => {
      const event = {
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_dup",
            mode: "payment",
            customer: "cus_c",
            customer_details: { email: "dup@example.com" },
            metadata: { packageId: "registers-bundle", option: "projectPack", credits: "5" },
          },
        },
      };
      for (let i = 0; i < 2; i++) {
        await fetch(`${base}/api/webhook/stripe`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "stripe-signature": "irrelevant-in-tests" },
          body: JSON.stringify(event),
        });
      }
      const balances = JSON.parse(await readFile(path.join(varDir, "credit-balances.json"), "utf8"));
      assert.equal(balances.cus_c.packages["registers-bundle"], 5); // not 10
    });
  });
});

describe("GET /api/redeem/status + POST /api/redeem", () => {
  test("status: 400 for an invalid token", async () => {
    await withApp({}, async ({ base }) => {
      const res = await fetch(`${base}/api/redeem/status?token=garbage`);
      assert.equal(res.status, 400);
    });
  });

  test("redeem: spends a credit and records the project, then 409s once exhausted", async () => {
    const stripe = makeFakeStripe();
    await withApp({ stripe, stripeWebhookSecret: "whsec_test" }, async ({ base, varDir }) => {
      // Grant 1 credit via the webhook, exactly like a real purchase would.
      await fetch(`${base}/api/webhook/stripe`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "stripe-signature": "x" },
        body: JSON.stringify({
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_redeem",
              mode: "payment",
              customer: "cus_redeem",
              customer_details: { email: "redeemer@example.com" },
              metadata: { packageId: "registers-bundle", option: "projectPack", credits: "1" },
            },
          },
        }),
      });
      const link = JSON.parse(
        (await readFile(path.join(varDir, "magic-links.jsonl"), "utf8")).trim(),
      );
      const token = new URL(link.redeemUrl).searchParams.get("token");

      const statusRes = await fetch(`${base}/api/redeem/status?token=${token}`);
      const statusBody = await statusRes.json();
      assert.equal(statusBody.ok, true);
      assert.equal(statusBody.packages["registers-bundle"], 1);

      const redeemRes = await fetch(`${base}/api/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          packageId: "registers-bundle",
          projectAddress: "1 Example St",
          clientName: "Acme Pty Ltd",
        }),
      });
      const redeemBody = await redeemRes.json();
      assert.equal(redeemRes.status, 200);
      assert.equal(redeemBody.remaining, 0);

      // Second redemption against the same (now empty) package -> 409.
      const secondRes = await fetch(`${base}/api/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          packageId: "registers-bundle",
          projectAddress: "2 Example St",
          clientName: "Acme Pty Ltd",
        }),
      });
      assert.equal(secondRes.status, 409);
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

describe("POST /api/webhook/stripe", () => {
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
