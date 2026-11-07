// Go-live 7 Nov 2026 (brief Rev02, 5.2; S3): Dan's sellable-now list narrows
// what the catalogue shows and sells, in the build and at checkout.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../lib/create-app.js";
import { applySellableList, loadSellableList } from "../lib/sellable-list.js";
import { buildList, parseCsv } from "../scripts/import-sellable-list.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cat = JSON.parse(await readFile(path.join(ROOT, "data/catalogue.json"), "utf8"));
const list = loadSellableList(path.join(ROOT, "data/sellable-now.json"));

describe("the committed sellable-now list", () => {
  test("is Rev01 of 7 Nov 2026: 72 packs now, 9 once the held entries land, 9 later-wave packs hidden, 10 held documents", () => {
    assert.equal(list.source, "SG_FORMS_SELLABLE_NOW_LIST_Rev01_07_Nov_2026.csv");
    assert.equal(list.packs_sellable_now.length, 72);
    assert.equal(list.packs_sellable_once_held_land.length, 9);
    assert.equal(list.packs_hidden_later_wave.length, 9);
    assert.equal(list.held_documents.length, 10);
  });

  test("only narrows: every pack on it is one the catalogue already shows and sells, and every document is in the catalogue", () => {
    const byId = new Map(cat.packs.map((p) => [p.id, p]));
    for (const id of list.packs_sellable_now) {
      const p = byId.get(id);
      assert.ok(p, `${id} is not in the catalogue`);
      assert.ok(p.show && p.sellable && p.purchasable !== false, `${id} is on the list but the catalogue doesn't sell it`);
    }
    const codes = new Set(cat.documents.map((d) => d.code));
    for (const c of list.documents) assert.ok(codes.has(c), `${c} is not in the catalogue`);
  });

  test("the pack-level CSV copy in docs/go-live matches the list", async () => {
    const rows = parseCsv(await readFile(path.join(ROOT, "docs/go-live/SG_FORMS_SELLABLE_NOW_LIST_Rev01_07_Nov_2026.packs.csv"), "utf8"));
    const h = rows[0];
    const now = rows.slice(1).filter((r) => r[h.indexOf("shown_at_launch")] === "Yes" && r[h.indexOf("sellable_now")] === "Yes").map((r) => r[0]).sort();
    assert.deepEqual(now, [...list.packs_sellable_now].sort());
  });
});

describe("applying the list", () => {
  test("hides and stops selling packs not on it, and stops held or unlisted documents being sold singly", () => {
    const small = {
      packs: [{ id: "a", show: true, sellable: true }, { id: "b", show: true, sellable: true }, { id: "c", show: false, sellable: false }],
      documents: [{ code: "D1", sellable: true }, { code: "D2", sellable: true }, { code: "D3", sellable: true }, { code: "D4", sellable: false }],
    };
    const out = applySellableList(small, { schema: 1, packs_sellable_now: ["a", "c"], documents: ["D1", "D2", "D4"], held_documents: ["D2"] });
    assert.deepEqual(out.packs.map((p) => [p.id, p.show, p.sellable]), [["a", true, true], ["b", false, false], ["c", false, false]]);
    assert.deepEqual(out.documents.map((d) => [d.code, d.sellable]), [["D1", true], ["D2", false], ["D3", false], ["D4", false]]);
    assert.equal(small.packs[1].show, true, "the catalogue object itself is untouched");
  });

  test("the import script reads the CSV (BOM, quotes, commas in numbers)", () => {
    const csv = "﻿pack_id,pack_name,group,trade,level,price_one_off_aud_ex_gst,launch_wave_pricing_rev08,shown_at_launch,sellable_now_current_ledger,sellable_once_held_rev24_entries_land,pack_document_count,doc_code,doc_is_held_rev24_entry\n"
      + 'p1,"Pack, One",trade-packs,T,Domestic,"1,119",mar-2027,Yes,Yes,Yes,2,D1,\n'
      + 'p1,"Pack, One",trade-packs,T,Domestic,"1,119",mar-2027,Yes,Yes,Yes,2,D2,Yes (Rev06)\n'
      + "p2,Pack Two,builder-packs,,Domestic,499,mar-2027,Yes,No,Yes,1,D2,Yes (Rev06)\n"
      + "p3,Pack Three,specialist-packs,,,299,later,No (wave 'later'),Yes,Yes,1,D3,\n";
    const { json, packCsv } = buildList(csv, { source: "x.csv", revision: "RevT" });
    assert.deepEqual(json.packs_sellable_now, ["p1"]);
    assert.deepEqual(json.packs_sellable_once_held_land, ["p2"]);
    assert.deepEqual(json.packs_hidden_later_wave, ["p3"]);
    assert.deepEqual(json.held_documents, ["D2"]);
    assert.deepEqual(json.documents, ["D1", "D2", "D3"]);
    assert.match(packCsv, /^p1,"Pack, One",trade-packs,T,Domestic,1119,/m);
    assert.throws(() => buildList("a,b\n1,2\n", { source: "x" }), /no pack_id column/);
  });
});

describe("checkout follows the list", () => {
  async function withApp(listBody, fn) {
    const dir = await mkdtemp(path.join(tmpdir(), "sg-sellable-"));
    const catalogPath = path.join(dir, "catalogue.json");
    await writeFile(catalogPath, JSON.stringify(cat));
    const listPath = path.join(dir, "sellable-now.json");
    if (listBody !== null) await writeFile(listPath, listBody);
    const calls = [];
    const stripe = { checkout: { sessions: { create: async (p) => { calls.push(p); return { id: "cs_test_1", url: "https://stripe.test/c" }; } } } };
    const app = createApp({ catalogPath, varDir: path.join(dir, "var"), publicDir: null, stripe, stripeTestMode: true, publicOrigin: "http://localhost:4300",
      mailer: { configured: false }, leadAllowedOrigins: [], sellableListPath: listPath,
      switches: async () => ({ sales_open: true, delivery_sla_business_days: 3, subscriptions_open: false, consultant_plans_open: false }) });
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try { await fn({ base, calls }); } finally { await new Promise((r) => server.close(r)); await rm(dir, { recursive: true, force: true }); }
  }
  const buy = (base, cart) => fetch(`${base}/api/checkout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cart, acceptedTerms: true }) });

  test("a pack on the list sells; one held back by the list, or a held document, is refused", async () => {
    await withApp(JSON.stringify(list), async ({ base, calls }) => {
      assert.equal((await buy(base, [{ packageId: list.packs_sellable_now[0] }])).status, 200);
      const blocked = list.packs_sellable_once_held_land[0];
      const r = await buy(base, [{ packageId: blocked }]);
      assert.equal(r.status, 409, `${blocked} is refused`);
      assert.equal((await buy(base, [{ documentCode: list.held_documents[0] }])).status, 409);
      assert.equal(calls.length, 1);
      const health = await (await fetch(`${base}/api/health`)).json();
      assert.equal(health.catalogue.on_sale, 72);
      assert.equal(health.catalogue.sellable_list, "Rev01, 7 Nov 2026");
    });
  });

  test("fail closed: a missing or broken list means nothing is on sale", async () => {
    for (const body of [null, "{not json", JSON.stringify({ schema: 2 })]) {
      await withApp(body, async ({ base, calls }) => {
        assert.equal((await buy(base, [{ packageId: list.packs_sellable_now[0] }])).status, 409);
        assert.equal(calls.length, 0);
      });
    }
  });
});
