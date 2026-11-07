// Go-live 7 Nov 2026 (brief Rev02, Section 2 and 5.2): the FORMS switches,
// read from FORMS GET /api/v3/storefront/switches. Fail closed everywhere.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../lib/create-app.js";
import { CLOSED, makeSwitchReader, normaliseSwitches, switchesUrlFrom } from "../lib/forms-switches.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALL_ON = { sales_open: true, delivery_mode: "manual", delivery_sla_business_days: 3, subscriptions_open: true, consultant_plans_open: true };
const answer = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe("reading the switches from FORMS", () => {
  test("the URL sits beside the order intake, on the same FORMS host", () => {
    assert.equal(switchesUrlFrom("https://forms.example/api/v3/storefront-orders"), "https://forms.example/api/v3/storefront/switches");
    assert.equal(switchesUrlFrom(undefined), null);
    assert.equal(switchesUrlFrom("not a url"), null);
  });

  test("sends the storefront intake key, and reads FORMS' answer", async () => {
    const calls = [];
    const read = makeSwitchReader({ url: "https://forms.example/api/v3/storefront/switches", apiKey: "k1",
      fetchImpl: async (url, init) => { calls.push({ url, init }); return answer(200, { ...ALL_ON, delivery_sla_business_days: 5 })(); } });
    const sw = await read();
    assert.equal(calls[0].init.headers["x-storefront-api-key"], "k1");
    assert.equal(sw.sales_open, true);
    assert.equal(sw.delivery_sla_business_days, 5);
    assert.equal(sw.read_ok, true);
    await read();
    assert.equal(calls.length, 1, "cached for a short time");
  });

  test("fail closed: no URL or key, an error status, a throw, or a malformed body are all OFF", async () => {
    assert.deepEqual(await makeSwitchReader({ url: "", apiKey: "k" })(), CLOSED);
    assert.deepEqual(await makeSwitchReader({ url: "https://f/x", apiKey: "" })(), CLOSED);
    assert.deepEqual(await makeSwitchReader({ url: "https://f/x", apiKey: "k", fetchImpl: answer(401, { error: "no" }) })(), CLOSED);
    assert.deepEqual(await makeSwitchReader({ url: "https://f/x", apiKey: "k", fetchImpl: answer(503, ALL_ON) })(), CLOSED);
    assert.deepEqual(await makeSwitchReader({ url: "https://f/x", apiKey: "k", fetchImpl: async () => { throw new Error("down"); } })(), CLOSED);
    assert.deepEqual(normaliseSwitches({ sales_open: "on", subscriptions_open: true, consultant_plans_open: true }), CLOSED);
    assert.deepEqual(normaliseSwitches(null), CLOSED);
    assert.equal(normaliseSwitches({ ...ALL_ON, delivery_sla_business_days: 99 }).delivery_sla_business_days, 3, "SLA falls back to 3");
    assert.equal(CLOSED.sales_open || CLOSED.subscriptions_open || CLOSED.consultant_plans_open, false);
    assert.equal(CLOSED.delivery_sla_business_days, 3);
  });
});

async function withApp(opts, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sg-switches-"));
  const catalogPath = path.join(dir, "catalogue.json");
  await writeFile(catalogPath, JSON.stringify({
    schema: 1, preview: false, currency: "AUD", generated_at: "2026-11-07T00:00:00+00:00",
    packs: [
      { id: "subcontractor:CARP:domestic", group: "trade-packs", name: "Carpentry Pack: Domestic", listed: true, sellable: true, show: true,
        count: 1, documents: ["SAF-SWMS-CARP-001"], prices: { one_off: 599, annual: 1049, monthly: 100 } },
      { id: "consultant:t1", group: "consultants", name: "Consultant T1", listed: true, sellable: true, show: true,
        count: 1, documents: ["SAF-SWMS-CARP-001"], prices: { one_off: 999, annual: 7999, monthly: 765 } },
    ],
    documents: [{ code: "SAF-SWMS-CARP-001", title: "General Carpentry Works", family: "SWMS", price: 49, sellable: true }],
  }));
  const calls = [];
  const stripe = { checkout: { sessions: { create: async (p) => { calls.push(p); return { id: "cs_test_1", url: "https://stripe.test/c" }; } } } };
  const app = createApp({ catalogPath, varDir: path.join(dir, "var"), publicDir: null, stripe, stripeTestMode: true,
    publicOrigin: "http://localhost:4300", mailer: { configured: false }, leadAllowedOrigins: [], ...opts });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, calls, varDir: path.join(dir, "var") });
  } finally {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
}
const checkout = (base, cart) => fetch(`${base}/api/checkout`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ cart, acceptedTerms: true }) });

describe("the storefront enforces the switches too", () => {
  test("no switches given (or FORMS can't be asked): no checkout, and Stripe is never called", async () => {
    await withApp({}, async ({ base, calls }) => {
      const res = await checkout(base, [{ packageId: "subcontractor:CARP:domestic" }]);
      assert.equal(res.status, 503);
      assert.match((await res.json()).reason, /aren't open yet/);
      assert.equal(calls.length, 0);
      const sw = await (await fetch(`${base}/api/switches`)).json();
      assert.deepEqual(sw, { sales_open: false, checkout_open: false, delivery_sla_business_days: 3, subscriptions_open: false, consultant_plans_open: false });
    });
    await withApp({ switches: async () => { throw new Error("FORMS down"); } }, async ({ base, calls }) => {
      assert.equal((await checkout(base, [{ packageId: "subcontractor:CARP:domestic" }])).status, 503);
      assert.equal(calls.length, 0);
    });
  });

  test("sales_open off: refused before Stripe; on: the one-off checkout opens", async () => {
    await withApp({ switches: async () => ({ ...ALL_ON, sales_open: false }) }, async ({ base, calls }) => {
      assert.equal((await checkout(base, [{ packageId: "subcontractor:CARP:domestic" }])).status, 503);
      assert.equal(calls.length, 0);
    });
    await withApp({ switches: async () => ({ ...ALL_ON, subscriptions_open: false, consultant_plans_open: false }) }, async ({ base, calls }) => {
      assert.equal((await checkout(base, [{ packageId: "subcontractor:CARP:domestic" }])).status, 200);
      assert.equal(calls.length, 1);
    });
  });

  test("consultant_plans_open off: a consultant plan line is refused (409) even with sales open", async () => {
    await withApp({ switches: async () => ({ ...ALL_ON, consultant_plans_open: false }) }, async ({ base, calls }) => {
      const res = await checkout(base, [{ packageId: "consultant:t1" }]);
      assert.equal(res.status, 409);
      assert.match((await res.json()).reason, /Coming soon: register interest/);
      assert.equal(calls.length, 0);
    });
  });

  test("beta still wins: checkout_open is false in beta whatever FORMS says", async () => {
    await withApp({ beta: true, switches: async () => ALL_ON }, async ({ base, calls }) => {
      const res = await fetch(`${base}/api/switches`);
      assert.equal(res.headers.get("cache-control"), "no-store");
      const sw = await res.json();
      assert.equal(sw.checkout_open, false);
      assert.equal(sw.subscriptions_open, true);
      assert.equal((await checkout(base, [{ packageId: "subcontractor:CARP:domestic" }])).status, 503);
      assert.equal(calls.length, 0);
    });
  });

  test("register interest: /api/lead keeps the forms-interest tag, the interest and the consent basis", async () => {
    const sent = [];
    const mailer = { configured: true, send: async (m) => { sent.push(m); return { ok: true, id: "e1" }; } };
    await withApp({ mailer, leadNotificationEmailTo: "dan@siteguardsystems.com.au" }, async ({ base, varDir }) => {
      const res = await fetch(`${base}/api/lead`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "forms", name: "Pat", email: "delivered@resend.dev", enquiry_type: "forms-interest", interest: "consultant_plans",
          consent: "yes", consent_wording: "Email me when SiteGuard FORMS subscriptions or consultant plans open." }) });
      assert.equal(res.status, 200);
      const lead = JSON.parse((await readFile(path.join(varDir, "leads.jsonl"), "utf8")).trim());
      assert.equal(lead.enquiry_type, "forms-interest");
      assert.equal(lead.interest, "consultant_plans");
      assert.equal(lead.consent_basis, "express");
      assert.match(sent[0].subject, /Registered interest/);
      assert.match(sent[0].text, /Interest: FORMS consultant plans/);
      const bad = await fetch(`${base}/api/lead`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "forms", name: "Pat", email: "delivered@resend.dev", enquiry_type: "forms-interest", interest: "app" }) });
      assert.equal(bad.status, 200);
      const leads = (await readFile(path.join(varDir, "leads.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
      assert.equal(leads[1].interest, "both", "an unknown interest becomes both");
      assert.equal(leads[1].consent_basis, "enquiry");
    });
  });

  test("server.js reads the switches from FORMS with the intake key and passes them in", async () => {
    const src = await readFile(path.join(ROOT, "server.js"), "utf8");
    assert.match(src, /makeSwitchReader\(\{ url: FORMS_SWITCHES_URL, apiKey: ORDER_INTAKE_API_KEY \}\)/);
    assert.match(src, /switches: readSwitches,/);
  });
});
