import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { createApp } from "./create-app.js";

const SAMPLE_CATALOG = {
  currency: "aud",
  items: [
    {
      id: "single-swms",
      tier: "self-serve",
      name: "Single SWMS",
      tagline: "One controlled SWMS",
      unit_amount: 14900,
    },
    {
      id: "ims-quote",
      tier: "quote",
      name: "ISO / IMS Framework",
      tagline: "Scoped before checkout",
    },
  ],
};

/** A fake Stripe client — no network calls, records what it was asked to do. */
function makeFakeStripe() {
  const calls = [];
  return {
    calls,
    checkout: {
      sessions: {
        create: async (params) => {
          calls.push(params);
          return { id: "cs_test_123", url: "https://checkout.stripe.com/test-session" };
        },
      },
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
  test("returns the catalog plus stripe flags", async () => {
    await withApp({ stripe: makeFakeStripe(), stripeTestMode: true }, async ({ base }) => {
      const res = await fetch(`${base}/api/packages`);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.items.length, 2);
      assert.equal(body.stripeConfigured, true);
      assert.equal(body.stripeTestMode, true);
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
