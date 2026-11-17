// FORMS queue S10 (pairs with SiteGuard-Forms F11): "Lost your documents?".
// The storefront passes order number + email to FORMS
// POST /api/v3/orders/redelivery-request and always answers the same sentence.
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { createApp, REDELIVERY_MESSAGE } from "../lib/create-app.js";
import { CLOSED, normaliseSwitches } from "../lib/forms-switches.js";

const ON = { sales_open: false, delivery_mode: "manual", delivery_sla_business_days: 3, subscriptions_open: false, consultant_plans_open: false, redelivery_open: true };
const SAME = "If that matches an order, we've emailed the delivery address.";

async function withApp({ switches = async () => ON, forms = async () => ({ status: 202 }), ...opts } = {}, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sg-redeliver-"));
  const catalogPath = path.join(dir, "catalogue.json");
  await writeFile(catalogPath, JSON.stringify({ schema: 1, preview: false, currency: "AUD", generated_at: "2026-11-16T00:00:00+00:00", packs: [], documents: [] }));
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, init, body: JSON.parse(init.body) });
    const r = await forms(url, init);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: new Headers(r.headers ?? {}), json: async () => ({}) };
  };
  const app = createApp({ catalogPath, varDir: path.join(dir, "var"), publicDir: null, stripe: null, stripeTestMode: true,
    publicOrigin: "http://localhost:4300", mailer: { configured: false }, leadAllowedOrigins: [],
    orderIntakeUrl: "https://forms.example/api/v3/storefront-orders", orderIntakeApiKey: "k-test", switches, fetchImpl, ...opts });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, sent });
  } finally {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
}
const ask = (base, body) => fetch(`${base}/api/redelivery-request`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("Lost your documents? (S10)", () => {
  test("the sentence is the one the FORMS endpoint uses", () => {
    assert.equal(REDELIVERY_MESSAGE, SAME);
  });

  test("redelivery_open is read from FORMS' switches and is off when missing", () => {
    assert.equal(CLOSED.redelivery_open, false);
    const base = { sales_open: true, subscriptions_open: false, consultant_plans_open: false };
    assert.equal(normaliseSwitches(base).redelivery_open, false);
    assert.equal(normaliseSwitches({ ...base, redelivery_open: "yes" }).redelivery_open, false);
    assert.equal(normaliseSwitches({ ...base, redelivery_open: true }).redelivery_open, true);
  });

  test("switch off (or FORMS can't be asked): 404 and nothing is sent to FORMS", async () => {
    for (const switches of [async () => ({ ...ON, redelivery_open: false }), async () => CLOSED, async () => { throw new Error("down"); }]) {
      await withApp({ switches }, async ({ base, sent }) => {
        const r = await ask(base, { order_number: "SGF-1001", email: "a@example.test" });
        assert.equal(r.status, 404);
        assert.equal(sent.length, 0);
        assert.equal((await (await fetch(`${base}/api/switches`)).json()).redelivery_open, false);
      });
    }
  });

  test("switch on: forwards order number and email to FORMS, and answers the same sentence whatever FORMS finds", async () => {
    for (const status of [202, 400, 500]) {
      await withApp({ forms: async () => ({ status }) }, async ({ base, sent }) => {
        const r = await ask(base, { order_number: " SGF-1001 ", email: "a@example.test" });
        assert.equal(r.status, 202, `FORMS ${status}`);
        assert.deepEqual(await r.json(), { ok: true, message: SAME });
        assert.equal(sent.length, 1);
        assert.equal(sent[0].url, "https://forms.example/api/v3/orders/redelivery-request");
        assert.deepEqual(sent[0].body, { order_number: "SGF-1001", email: "a@example.test" });
        assert.equal(sent[0].init.headers["x-storefront-api-key"], "k-test");
      });
    }
    await withApp({ forms: async () => { throw new Error("FORMS down"); } }, async ({ base }) => {
      const r = await ask(base, { order_number: "SGF-1001", email: "a@example.test" });
      assert.equal(r.status, 202);
      assert.equal((await r.json()).message, SAME);
    });
  });

  test("a malformed order number or email gets the same sentence and isn't sent on; empty fields are asked for", async () => {
    await withApp({}, async ({ base, sent }) => {
      for (const body of [{ order_number: "x", email: "a@example.test" }, { order_number: "SGF-1001", email: "not-an-email" }, { order_number: "<script>", email: "a@example.test" }]) {
        const r = await ask(base, body);
        assert.equal(r.status, 202);
        assert.equal((await r.json()).message, SAME);
      }
      assert.equal(sent.length, 0);
      assert.equal((await ask(base, { order_number: "", email: "" })).status, 400);
    });
  });

  test("honeypot filled: the same sentence, nothing sent", async () => {
    await withApp({}, async ({ base, sent }) => {
      const r = await ask(base, { order_number: "SGF-1001", email: "a@example.test", website: "http://spam.test" });
      assert.equal(r.status, 202);
      assert.equal((await r.json()).message, SAME);
      assert.equal(sent.length, 0);
    });
  });

  test("rate limited here after 5 tries in 15 minutes, and FORMS' own 429 passes through, both with the same sentence", async () => {
    await withApp({}, async ({ base, sent }) => {
      for (let i = 0; i < 5; i++) assert.equal((await ask(base, { order_number: `SGF-10${i}0`, email: "a@example.test" })).status, 202);
      const r = await ask(base, { order_number: "SGF-1099", email: "a@example.test" });
      assert.equal(r.status, 429);
      assert.equal((await r.json()).reason, SAME);
      assert.equal(sent.length, 5);
    });
    await withApp({ forms: async () => ({ status: 429, headers: { "retry-after": "600" } }) }, async ({ base }) => {
      const r = await ask(base, { order_number: "SGF-1001", email: "a@example.test" });
      assert.equal(r.status, 429);
      assert.equal(r.headers.get("retry-after"), "600");
      assert.equal((await r.json()).message, SAME);
    });
  });

  test("FORMS says 404 (its switch is off): 404 here too", async () => {
    await withApp({ forms: async () => ({ status: 404 }) }, async ({ base }) => {
      assert.equal((await ask(base, { order_number: "SGF-1001", email: "a@example.test" })).status, 404);
    });
  });
});

describe("the Lost your documents? page (built site; npm test builds dist/ first)", () => {
  test("the form and every link to the page stay hidden until FORMS says redelivery_open is on", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
    const page = await readFile(path.join(dist, "lost-documents/index.html"), "utf8");
    assert.match(page, /<div data-switch="redelivery_open" data-when="on" hidden><form class="form" data-redelivery-form/);
    assert.match(page, /<div data-switch="redelivery_open" data-when="off">[^]*Contact us/);
    const home = await readFile(path.join(dist, "index.html"), "utf8");
    for (const [, li] of home.matchAll(/(<li[^>]*><a href="\/lost-documents\/">)/g)) assert.match(li, /data-switch="redelivery_open" data-when="on" hidden/);
    assert.ok(home.includes('href="/lost-documents/"'), "linked from the footer");
  });
});
