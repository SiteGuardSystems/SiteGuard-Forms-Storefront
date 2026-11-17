// FORMS queue S11: "Tell me when this pack opens" (pack pages while orders are
// closed). /api/lead enquiry_type "pack-interest": the pack id, and express
// consent ONLY when the box was ticked; otherwise an enquiry.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../lib/create-app.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORDING = "Email me when this pack can be ordered, and with SiteGuard FORMS news. I can unsubscribe at any time.";

async function withApp(opts, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sg-packint-"));
  const catalogPath = path.join(dir, "catalogue.json");
  await writeFile(catalogPath, JSON.stringify({ schema: 1, preview: false, currency: "AUD", generated_at: "2026-11-16T00:00:00+00:00",
    packs: [{ id: "subcontractor:CARP:domestic", group: "trade-packs", name: "Carpentry Pack: Domestic", listed: true, sellable: true, show: true, count: 1, documents: [], prices: { one_off: 599, annual: 1049, monthly: 100 } },
      { id: "subcontractor:HIDE:domestic", group: "trade-packs", name: "Hidden", listed: false, sellable: false, show: false, count: 1, documents: [], prices: { one_off: 1, annual: 1, monthly: 1 } }],
    documents: [] }));
  const sent = [];
  const mailer = { configured: true, send: async (m) => { sent.push(m); return { ok: true, id: "e1" }; } };
  const app = createApp({ catalogPath, varDir: path.join(dir, "var"), publicDir: null, stripe: null, stripeTestMode: true,
    publicOrigin: "http://localhost:4300", mailer, leadNotificationEmailTo: "delivered@resend.dev", leadAllowedOrigins: [], ...opts });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, sent, leads: async () => (await readFile(path.join(dir, "var", "leads.jsonl"), "utf8")).trim().split("\n").map(JSON.parse) });
  } finally {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
}
const lead = (base, body) => fetch(`${base}/api/lead`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ source: "forms", name: "Pat", email: "delivered@resend.dev", enquiry_type: "pack-interest", ...body }) });

describe("Tell me when this pack opens (S11)", () => {
  test("box ticked: express consent with the wording shown, the time and the page; the pack is kept", async () => {
    await withApp({}, async ({ base, sent, leads }) => {
      const r = await lead(base, { pack: "subcontractor:CARP:domestic", consent: "yes", consent_wording: WORDING, consent_source: "https://www.siteguardforms.com.au/trade-packs/carpentry/" });
      assert.equal(r.status, 200);
      const [l] = await leads();
      assert.equal(l.enquiry_type, "pack-interest");
      assert.equal(l.pack, "subcontractor:CARP:domestic");
      assert.equal(l.interest, "pack");
      assert.equal(l.consent_basis, "express");
      assert.equal(l.consent_wording, WORDING);
      assert.match(l.consent_at, /^\d{4}-\d\d-\d\dT/);
      assert.equal(l.consent_source, "https://www.siteguardforms.com.au/trade-packs/carpentry/");
      assert.match(sent[0].subject, /Registered interest/);
      assert.match(sent[0].text, /Enquiry type: FORMS pack interest/);
      assert.match(sent[0].text, /Pack: subcontractor:CARP:domestic/);
      assert.match(sent[0].text, /Consent basis: express/);
    });
  });

  test("box not ticked: an enquiry, and no consent wording is stored even if sent", async () => {
    await withApp({}, async ({ base, leads }) => {
      await lead(base, { pack: "subcontractor:CARP:domestic", consent: "", consent_wording: WORDING });
      const [l] = await leads();
      assert.equal(l.consent_basis, "enquiry");
      assert.equal(l.consent_wording, "");
      assert.equal(l.pack, "subcontractor:CARP:domestic");
    });
  });

  test("a pack the shop doesn't list (or a made-up id) is dropped and the lead becomes plain FORMS interest", async () => {
    await withApp({}, async ({ base, leads }) => {
      await lead(base, { pack: "subcontractor:HIDE:domestic", consent: "yes", consent_wording: WORDING });
      await lead(base, { pack: "<script>alert(1)</script>" });
      const ls = await leads();
      for (const l of ls) { assert.equal(l.pack, undefined); assert.equal(l.enquiry_type, "forms-interest"); }
      assert.equal(ls[0].consent_basis, "express", "the box was still ticked");
    });
  });

  test("honeypot: answered as if it worked, nothing kept", async () => {
    await withApp({}, async ({ base, sent }) => {
      const r = await lead(base, { pack: "subcontractor:CARP:domestic", website: "http://spam.test" });
      assert.equal(r.status, 200);
      assert.equal(sent.length, 0);
    });
  });
});

describe("the browser swap (public/assets/app.js)", () => {
  test("the opt-in box starts unticked, the wording sent is the wording shown, and closed is the fallback", async () => {
    const js = await readFile(path.join(ROOT, "public/assets/app.js"), "utf8");
    assert.ok(js.includes(`var PACK_OPT_IN = "${WORDING}";`));
    assert.match(js, /<input type="checkbox" name="consent" id="/);
    assert.doesNotMatch(js, /name="consent"[^>]*checked/);
    assert.match(js, /consent_wording: ticked \? PACK_OPT_IN : ""/);
    assert.match(js, /if \(!sw \|\| sw\.checkout_open !== true\) ordersClosed\(\);/);
    assert.match(js, /\.catch\(ordersClosed\)/);
  });
});
