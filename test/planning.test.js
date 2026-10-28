// Planning calendar and inspection planner (scripts/lib/planning.mjs). The same
// file and the same tests live in siteguard-website and SiteGuard-Forms-Storefront.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadPlanning, planningIndexBody, planningStateBody, inspectionsIndexBody, inspectionGroupBody, inspectionGroups, icsFor, upcoming, STATES } from "../scripts/lib/planning.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TODAY = new Date("2026-11-01T00:00:00Z");
const SRC = [{ id: "s1", publisher: "Business Victoria", title: "Public holidays", url: "https://business.vic.gov.au/x" }];
const CAL = { checked: "2026-10-28", sources: SRC, events: [
  { date: "2026-10-01", title: "Gone", category: "event", states: ["ALL"], source: "s1" },
  { date: "2026-11-03", title: "Melbourne Cup Day", category: "public-holiday", states: ["VIC"], note: "Metro only", source: "s1" },
  { date: "2026-12-25", title: "Christmas Day", category: "public-holiday", states: ["ALL"], source: "s1" },
  { date: "2026-11-16", title: "RDO", category: "rdo", states: ["NSW"], source: "s1" },
  { month: "2027-10", title: "Safe Work Month", category: "initiative", states: ["ALL"], source: "s1" },
] };
const INSP = { checked: "2026-10-28", sources: SRC, items: [
  { group: "Electrical", item: "Portable RCD, operating time", interval: "Every 3 months", basis: "Standard", reference: "AS/NZS 3760:2022", applies_to: "Construction", source: "s1" },
  { group: "Fire", item: "Extinguishers", interval: "Every 6 months", basis: "Standard", reference: "AS 1851-2012", applies_to: "All workplaces", source: "s1" },
] };
async function fixture(cal, insp) {
  const root = await mkdtemp(path.join(tmpdir(), "plan-"));
  await mkdir(path.join(root, "data"));
  if (cal) await writeFile(path.join(root, "data/planning-calendar.json"), JSON.stringify(cal));
  if (insp) await writeFile(path.join(root, "data/inspection-planner.json"), JSON.stringify(insp));
  return root;
}

test("good data loads without problems; past dates drop off; months group in order", async () => {
  const p = await loadPlanning(await fixture(CAL, INSP), { today: TODAY });
  assert.deepEqual(p.problems, []);
  const m = upcoming(p.cal, TODAY);
  assert.deepEqual([...m.keys()], ["2026-11", "2026-12", "2027-10"]);
  assert.deepEqual(m.get("2026-11").map((e) => e.title), ["Melbourne Cup Day", "RDO"]);
});

test("state pages: own and national entries only; index lists every state; no inline script or style", async () => {
  const p = await loadPlanning(await fixture(CAL, INSP), { today: TODAY });
  const vic = planningStateBody(p, "VIC", { today: TODAY });
  assert.match(vic, /Melbourne Cup Day/);
  assert.match(vic, /Christmas Day/);
  assert.ok(!/>RDO </.test(vic), "NSW-only entry not on the VIC page");
  assert.match(vic, /Date to be confirmed/);
  assert.ok(!vic.includes("Gone"));
  assert.match(vic, /href="\/planning\/siteguard-planning-vic\.ics"/);
  assert.match(vic, /<a href="\/planning\/vic\/" aria-current="page">Victoria<\/a>/);
  const idx = planningIndexBody(p, { today: TODAY });
  for (const s of STATES) assert.match(idx, new RegExp(`href="/planning/${s.toLowerCase()}/"`));
  assert.ok(!/Melbourne Cup/.test(idx), "index lists initiatives and events, not holidays");
  assert.deepEqual(inspectionGroups(p.insp).map((g) => g.slug), ["electrical", "fire"]);
  const insIdx = inspectionsIndexBody(p, { today: TODAY });
  assert.match(insIdx, /href="\/planning\/inspections\/electrical\/"/);
  const insp = inspectionGroupBody(p, "electrical", { today: TODAY });
  assert.match(insp, /data-applies="Construction"/);
  assert.ok(!/AS 1851-2012/.test(insp), "other sections' items not on this page");
  assert.match(inspectionGroupBody(p, "fire", { today: TODAY }), /AS 1851-2012/);
  for (const html of [vic, idx, insIdx, insp]) assert.ok(!/ on[a-z]+="| style="|<script/.test(html));
});

test("ics: a state's file has its own and national dated entries only", async () => {
  const p = await loadPlanning(await fixture(CAL, INSP), { today: TODAY });
  const vic = icsFor(p, "VIC", { today: TODAY, origin: "https://www.example.com.au", brand: "SiteGuard" });
  assert.match(vic, /^BEGIN:VCALENDAR\r\n/);
  assert.match(vic, /DTSTART;VALUE=DATE:20261103\r\nDTEND;VALUE=DATE:20261104/);
  assert.match(vic, /SUMMARY:Christmas Day/);
  assert.ok(!/SUMMARY:RDO/.test(vic), "NSW-only entry not in VIC");
  assert.ok(!/Safe Work Month/.test(vic), "undated entry not in a calendar file");
  assert.ok(vic.split("\r\n").every((l) => l.length <= 75));
});

test("bad entries are reported", async () => {
  const bad = { checked: "2026-10-28", sources: SRC, events: [
    { date: "3 Nov", title: "x", category: "public-holiday", states: ["VIC"], source: "s1" },
    { date: "2026-11-03", title: "y", category: "party", states: ["VIC"], source: "s1" },
    { date: "2026-11-03", title: "z", category: "rdo", states: ["Vic"], source: "s1" },
    { date: "2026-11-03", title: "w", category: "rdo", states: ["VIC"], source: "nope" },
  ] };
  const badInsp = { checked: "2026-10-28", sources: SRC, items: [{ group: "G", item: "I", interval: "", basis: "Law", reference: "R", applies_to: "All workplaces", source: "s1" }] };
  const p = await loadPlanning(await fixture(bad, badInsp), { today: TODAY });
  for (const re of [/needs a date/, /category must be/, /states must be/, /source "nope"/, /interval is required/, /basis must be/]) assert.ok(p.problems.some((m) => re.test(m)), `${re}: ${p.problems.join("; ")}`);
});

test("VIC basis shown beside the model WHS basis when they differ", async () => {
  const insp2 = { ...INSP, items: [{ ...INSP.items[0], basis: "Mandatory", vic_basis: "Code of practice", confidence: "medium", jurisdiction_note: "VIC: industry standard" }] };
  const p = await loadPlanning(await fixture(CAL, insp2), { today: TODAY });
  assert.deepEqual(p.problems, []);
  const html = inspectionGroupBody(p, "electrical", { today: TODAY });
  assert.match(html, /WHS states<\/span><span class="plan-basis basis-mandatory">Mandatory/);
  assert.match(html, /VIC<\/span><span class="plan-basis basis-code-of-practice">Code of practice/);
  assert.match(html, /published summary of the standard/);
  assert.match(html, /<details class="plan-notes"><summary>State notes<\/summary><p>VIC: industry standard/);
});

test("stale data is an open item", async () => {
  const p = await loadPlanning(await fixture({ ...CAL, checked: "2026-01-01" }, INSP), { today: TODAY });
  assert.ok(p.problems.some((m) => /open item/.test(m)));
});

test("this site's data files are valid and identical in shape", async () => {
  const p = await loadPlanning(ROOT);
  assert.deepEqual(p.problems.filter((m) => !/open item/.test(m)), []);
  assert.ok(p.cal.events.length > 0 && p.insp.items.length > 0);
  for (const f of ["planning-calendar.json", "inspection-planner.json"]) JSON.parse(await readFile(path.join(ROOT, "data", f), "utf8"));
});
