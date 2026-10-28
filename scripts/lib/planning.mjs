// Planning calendar and inspection planner: shared by both SiteGuard websites
// (the same file lives in siteguard-website and SiteGuard-Forms-Storefront;
// keep them identical, and keep the two data files identical too).
//
//   data/planning-calendar.json   public holidays, building-industry RDOs,
//                                 safety initiatives and industry events
//   data/inspection-planner.json  how often common workplace items are
//                                 inspected or tested, and on what basis
//
// Pages: /planning/ (pick a state; national safety initiatives and events),
// /planning/<state>/ (that state's holidays and RDOs plus national entries,
// with an .ics file to subscribe to) and /planning/inspections/. Every entry
// cites a source. Dates before the build day drop off; the pages work without
// JavaScript, and with it the category and workplace filters hide entries.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { esc } from "./md.mjs";

export const STATES = ["VIC", "NSW", "QLD", "SA", "WA", "TAS", "ACT", "NT"];
export const STATE_NAMES = { VIC: "Victoria", NSW: "New South Wales", QLD: "Queensland", SA: "South Australia", WA: "Western Australia", TAS: "Tasmania", ACT: "Australian Capital Territory", NT: "Northern Territory" };
export const CATEGORIES = {
  "public-holiday": "Public holiday",
  rdo: "Building industry RDO",
  initiative: "Safety initiative",
  event: "Industry event",
};
export const BASES = ["Mandatory", "Code of practice", "Regulator guidance", "Standard", "Manufacturer", "Good practice"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const MAX_AGE_DAYS = 200; // re-check the data at least twice a year

/** Read and check both data files. Returns { cal, insp, problems }. */
export async function loadPlanning(root, { today = new Date() } = {}) {
  const problems = [];
  const read = async (name) => {
    try { return JSON.parse(await readFile(path.join(root, "data", name), "utf8")); } catch (e) {
      if (e.code !== "ENOENT") problems.push(`${name}: ${e.message}`);
      return null;
    }
  };
  const cal = await read("planning-calendar.json");
  const insp = await read("inspection-planner.json");
  for (const [name, d, list] of [["planning-calendar.json", cal, "events"], ["inspection-planner.json", insp, "items"]]) {
    if (!d) continue;
    const ids = new Set((d.sources ?? []).map((s) => s.id));
    for (const s of d.sources ?? []) if (!s.id || !/^https:\/\//.test(s.url ?? "")) problems.push(`${name}: source ${s.id ?? "?"} needs an id and an https url`);
    if (!DATE_RE.test(d.checked ?? "")) problems.push(`${name}: checked (the date the data was last checked) is required`);
    else if ((today - Date.parse(d.checked)) / 86_400_000 > MAX_AGE_DAYS) problems.push(`${name}: last checked ${d.checked}, more than ${MAX_AGE_DAYS} days ago; re-check it against the sources (open item)`);
    for (const [i, e] of (d[list] ?? []).entries()) {
      const where = `${name} #${i + 1}${e?.title || e?.item ? ` (${e.title || e.item})` : ""}`;
      if (!ids.has(e.source)) problems.push(`${where}: source "${e.source}" is not in sources`);
      for (const a of e.also ?? []) if (!ids.has(a)) problems.push(`${where}: also-source "${a}" is not in sources`);
      if (e.url && !/^https:\/\//.test(e.url)) problems.push(`${where}: url must be https`);
      if (list === "events") {
        if (!e.title) problems.push(`${where}: title is required`);
        if (!CATEGORIES[e.category]) problems.push(`${where}: category must be ${Object.keys(CATEGORIES).join(", ")}`);
        if (e.date ? !DATE_RE.test(e.date) : !MONTH_RE.test(e.month ?? "")) problems.push(`${where}: needs a date (YYYY-MM-DD) or, if not yet announced, a month (YYYY-MM)`);
        if (e.end && (!DATE_RE.test(e.end) || e.end < e.date)) problems.push(`${where}: end must be a date on or after date`);
        if (!Array.isArray(e.states) || !e.states.length || e.states.some((s) => s !== "ALL" && !STATES.includes(s))) problems.push(`${where}: states must be ["ALL"] or a list of ${STATES.join(" ")}`);
      } else {
        for (const k of ["group", "item", "interval", "basis", "reference", "applies_to"]) if (!e[k]) problems.push(`${where}: ${k} is required`);
        if (e.basis && !BASES.includes(e.basis)) problems.push(`${where}: basis must be one of ${BASES.join(", ")}`);
        if (e.vic_basis && ![...BASES, "Not applicable"].includes(e.vic_basis)) problems.push(`${where}: vic_basis must be one of ${BASES.join(", ")} or Not applicable`);
        if (e.confidence && !["high", "medium"].includes(e.confidence)) problems.push(`${where}: confidence must be high or medium`);
      }
    }
  }
  return { cal, insp, problems };
}

const statesOf = (e) => (e.states?.includes("ALL") ? ["ALL"] : e.states);
const statesAttr = (e) => statesOf(e).join(" ");
const statesLabel = (e) => (statesOf(e)[0] === "ALL" ? "National" : statesOf(e).join(", "));
const dt = (iso) => new Date(iso + "T00:00:00Z");
const fmt = (iso, o) => dt(iso).toLocaleDateString("en-AU", { timeZone: "UTC", ...o });
const monthName = (ym) => fmt(ym + "-01", { month: "long", year: "numeric" });
const isoDay = (d) => d.toISOString().slice(0, 10);

/** Events still to come (or running) on `today`, sorted, grouped by month. */
export function upcoming(cal, today = new Date()) {
  const t = isoDay(today);
  const list = (cal?.events ?? []).filter((e) => (e.date ? (e.end || e.date) >= t : e.month >= t.slice(0, 7)));
  list.sort((a, b) => (a.date || a.month + "-99").localeCompare(b.date || b.month + "-99") || a.title.localeCompare(b.title));
  const months = new Map();
  for (const e of list) {
    const k = (e.date || e.month).slice(0, 7);
    if (!months.has(k)) months.set(k, []);
    months.get(k).push(e);
  }
  return months;
}

function sourceLink(d, id, url) {
  const s = (d.sources ?? []).find((x) => x.id === id);
  if (!s && !url) return "";
  return `<a class="plan-src" href="${esc(url || s.url)}" rel="noopener">${esc(s?.publisher ?? "Source")}</a>`;
}

function eventItem(cal, e) {
  const when = e.date
    ? `<time datetime="${e.date}"><span class="plan-day">${fmt(e.date, { day: "numeric" })}</span><span class="plan-wd">${fmt(e.date, { weekday: "short" })}</span></time>`
    : `<span class="plan-tbc" title="Date to be confirmed">TBC</span>`;
  const range = e.end && e.end !== e.date ? `<span class="plan-range">${fmt(e.date, { day: "numeric", month: "short" })} to ${fmt(e.end, { day: "numeric", month: "short", year: "numeric" })}</span>` : "";
  return `<li class="plan-event cat-${e.category}" data-states="${statesAttr(e)}" data-cat="${e.category}">
  <div class="plan-when">${when}</div>
  <div class="plan-what"><p class="plan-title">${esc(e.title)} <span class="plan-badge">${CATEGORIES[e.category]}</span></p>
  <p class="plan-meta">${e.date ? "" : "Date to be confirmed · "}${esc(statesLabel(e))}${e.location ? ` · ${esc(e.location)}` : ""}${range ? ` · ${range}` : ""}</p>
  ${e.note ? `<p class="plan-note">${esc(e.note)}</p>` : ""}
  <p class="plan-meta">${[sourceLink(cal, e.source, e.url), ...(e.also ?? []).filter((a) => cal.sources?.find((x) => x.id === a)?.publisher !== cal.sources?.find((x) => x.id === e.source)?.publisher).map((a) => sourceLink(cal, a))].join(" · ")}</p></div>
</li>`;
}

const forState = (e, st) => statesOf(e)[0] === "ALL" || e.states.includes(st);
const longDate = (iso) => fmt(iso, { day: "numeric", month: "long", year: "numeric" });
export const statePath = (st) => `/planning/${st.toLowerCase()}/`;
export const icsPath = (st) => `/planning/siteguard-planning-${st.toLowerCase()}.ics`;

function calendarList(cal, events, today) {
  const months = upcoming({ events }, today);
  if (!months.size) return `<p>Nothing listed yet. Check back soon.</p>`;
  return [...months].map(([ym, list]) => `<section class="plan-month" data-month="${ym}"><h3>${monthName(ym)}</h3><ul class="plan-events">${list.map((e) => eventItem(cal, e)).join("")}</ul><p class="plan-empty" hidden>Nothing listed for this selection this month.</p></section>`).join("");
}

function categoryFilter(cats) {
  return `<form class="plan-filter" data-plan-filter><fieldset class="plan-ctl"><legend>Show</legend>${cats.map((k) => `<label class="plan-check"><input type="checkbox" value="${k}" checked data-plan-cat> ${CATEGORIES[k]}</label>`).join("")}</fieldset></form>`;
}

function stateNav(current) {
  return `<nav class="plan-states" aria-label="State or territory"><ul>${STATES.map((s) => `<li><a href="${statePath(s)}"${s === current ? ' aria-current="page"' : ""}>${STATE_NAMES[s]}</a></li>`).join("")}</ul></nav>`;
}

/** /planning/: pick a state, the national safety calendar, links onward. */
export function planningIndexBody({ cal, insp }, { today = new Date() } = {}) {
  const national = (cal?.events ?? []).filter((e) => (e.category === "initiative" || e.category === "event"));
  return `<section class="band"><div class="wrap">
  <h2>Choose your state or territory</h2>
  <p>Each state's calendar lists its public holidays and building industry RDOs, plus the national safety initiatives and industry events.</p>
  ${stateNav(null)}
  <p class="plan-alt"><a class="btn" href="/planning/inspections/">Inspection and testing planner</a></p>
</div></section>
<section class="band band-grey"><div class="wrap">
  <h2>Safety initiatives and industry events</h2>
  <p class="lede">National and state safety campaigns, awareness days, conferences and expos. Dates checked ${esc(longDate(cal?.checked ?? isoDay(today)))}.</p>
  ${categoryFilter(["initiative", "event"])}
  <div class="plan-cal" data-plan-list>${calendarList(cal, national, today)}</div>
</div></section>`;
}

/** /planning/<state>/: that state's holidays and RDOs plus national entries. */
export function planningStateBody({ cal }, state, { today = new Date() } = {}) {
  const events = (cal?.events ?? []).filter((e) => forState(e, state));
  return `<section class="band"><div class="wrap">
  ${stateNav(state)}
  <p class="small">Dates checked ${esc(longDate(cal?.checked ?? isoDay(today)))}. The notes under Sources explain each RDO calendar.</p>
  <div class="btn-row"><a class="btn btn-small" href="${icsPath(state)}" download>Add to your calendar (.ics)</a><a class="btn btn-small" href="/planning/inspections/">Inspection and testing planner</a></div>
  ${categoryFilter(Object.keys(CATEGORIES))}
  <div class="plan-cal" data-plan-list>${calendarList(cal, events, today)}</div>
  <p class="small plan-fine">RDO dates are the building and construction industry calendars published for ${STATE_NAMES[state]}; whether they apply to your site depends on the award or agreement your workers are employed under. Public holidays are as published by the state or territory; check local, regional and part-day holidays against the official list.</p>
  <h2 class="plan-sub">Subscribe instead of downloading</h2>
  <p class="small">In Outlook, Google Calendar or Apple Calendar, choose "subscribe" or "add from URL" and paste the link of the .ics file above, so updates come through on their own.</p>
</div></section>
${sourcesBand(cal, "Sources", (cal?.sources ?? []).filter((s) => events.some((e) => e.source === s.id)))}`;
}

function sourcesBand(d, title, list) {
  return `<section class="band band-grey" id="sources"><div class="wrap"><h2>${title}</h2><ol class="plan-sources">${(list ?? d?.sources ?? []).map((s) => `<li><a href="${esc(s.url)}" rel="noopener">${esc(s.publisher)}: ${esc(s.title)}</a>${s.note ? `<br><span class="small">${esc(s.note)}</span>` : ""}</li>`).join("")}</ol></div></section>`;
}

export const groupSlug = (g) => g.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
/** The planner's groups in data order: [{ slug, title, items }]. */
export function inspectionGroups(insp) {
  const m = new Map();
  for (const it of insp?.items ?? []) {
    const k = groupSlug(it.group);
    if (!m.has(k)) m.set(k, { slug: k, title: it.group, items: [] });
    m.get(k).items.push(it);
  }
  return [...m.values()];
}
export const groupPath = (slug) => `/planning/inspections/${slug}/`;

const BASIS_TEXT = {
  Mandatory: "Set by an Act or regulation.",
  Standard: "Set by an Australian Standard. Often called up by a regulation, a code of practice or your contract.",
  "Code of practice": "Set by an approved code of practice or compliance code, which a court can use as evidence of what is reasonably practicable.",
  "Regulator guidance": "Published by the regulator as guidance, such as a WorkSafe industry standard. Not law in itself, but it shows what the regulator expects.",
  Manufacturer: "Follow the manufacturer's instructions.",
  "Good practice": "Common industry practice where nothing sets a fixed interval.",
};
const basisKey = () => `<dl class="plan-key">${BASES.map((b) => `<div><dt><span class="plan-basis basis-${b.toLowerCase().replace(/\s+/g, "-")}">${b}</span></dt><dd>${BASIS_TEXT[b]}</dd></div>`).join("")}</dl>`;
const plannerFine = (insp, today) => `<p class="small plan-fine">A planning guide, not legal advice. Intervals are minimums under normal conditions: shorten them where use, environment, damage or a risk assessment calls for it, and follow the current edition of the standard, your regulator's guidance and the manufacturer's instructions. Victoria operates under the Occupational Health and Safety Act 2004 and the OHS Regulations 2017; the other states and territories under the model WHS laws as adopted locally. Items checked ${esc(longDate(insp?.checked ?? isoDay(today)))}.</p>`;

function groupNav(insp, current) {
  return `<nav class="plan-states" aria-label="Planner sections"><ul>${inspectionGroups(insp).map((g) => `<li><a href="${groupPath(g.slug)}"${g.slug === current ? ' aria-current="page"' : ""}>${esc(g.title)}</a></li>`).join("")}</ul></nav>`;
}

/** /planning/inspections/: the sections of the planner and how to read it. */
export function inspectionsIndexBody({ insp }, { today = new Date() } = {}) {
  const groups = inspectionGroups(insp);
  return `<section class="band"><div class="wrap">
  <h2>Choose a section</h2>
  <ul class="plan-sections">${groups.map((g) => `<li><a href="${groupPath(g.slug)}"><b>${esc(g.title)}</b><span>${g.items.length} items</span></a></li>`).join("")}</ul>
  <h2 class="plan-sub">How to read the planner</h2>
  <p>Each item shows how often, what sets that interval, and the reference behind it. Where Victoria differs from the model WHS states and territories, both are shown; "State notes" under an item gives the detail.</p>
  ${basisKey()}
  ${plannerFine(insp, today)}
</div></section>`;
}

/** /planning/inspections/<section>/: one section of the planner. */
export function inspectionGroupBody({ insp }, slug, { today = new Date() } = {}) {
  const g = inspectionGroups(insp).find((x) => x.slug === slug);
  const items = g?.items ?? [];
  const applies = [...new Set(items.map((i) => i.applies_to))].sort((a, b) => (a === "All workplaces" ? -1 : b === "All workplaces" ? 1 : a.localeCompare(b)));
  const badge = (b) => `<span class="plan-basis basis-${esc(b.toLowerCase().replace(/\s+/g, "-"))}">${esc(b)}</span>`;
  const basisCell = (i) => i.vic_basis
    ? `<span class="plan-bj"><span class="plan-bj-l">WHS states</span>${badge(i.basis)}</span><span class="plan-bj"><span class="plan-bj-l">VIC</span>${badge(i.vic_basis)}</span>`
    : badge(i.basis);
  const refs = (i) => [sourceLink(insp, i.source, i.url), ...(i.also ?? []).map((a) => sourceLink(insp, a))].filter(Boolean).join(", ");
  const used = new Set(items.flatMap((i) => [i.source, ...(i.also ?? [])]));
  return `<section class="band"><div class="wrap">
  ${groupNav(insp, slug)}
  ${applies.length > 1 ? `<form class="plan-filter" data-plan-filter>
    <label class="plan-ctl" for="plan-applies">Workplace<select id="plan-applies" data-plan-applies><option value="">All items</option>${applies.filter((a) => a !== "All workplaces").map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join("")}</select></label>
  </form>` : ""}
  <section class="plan-group">
  <table class="plan-table"><thead><tr><th scope="col">Item</th><th scope="col">How often</th><th scope="col">Basis</th><th scope="col">Reference</th><th scope="col">Applies to</th></tr></thead><tbody>
  ${items.map((i) => `<tr data-applies="${esc(i.applies_to)}">
    <th scope="row" data-label="Item">${esc(i.item)}${i.who ? `<span class="plan-who">By: ${esc(i.who)}</span>` : ""}${i.jurisdiction_note ? `<details class="plan-notes"><summary>State notes</summary><p>${esc(i.jurisdiction_note)}</p></details>` : ""}</th>
    <td data-label="How often"><b>${esc(i.interval)}</b>${i.trigger ? `<span class="plan-trigger">${esc(i.trigger)}</span>` : ""}</td>
    <td data-label="Basis">${basisCell(i)}</td>
    <td data-label="Reference">${esc(i.reference)}${i.confidence === "medium" ? `<span class="plan-conf" title="${esc(i.confidence_note ?? "")}">From a published summary of the standard; check the current edition.</span>` : ""}<span class="plan-refs">${refs(i)}</span></td>
    <td data-label="Applies to">${esc(i.applies_to)}</td></tr>`).join("")}
  </tbody></table></section>
  <p class="small"><a href="/planning/inspections/">What the basis labels mean</a></p>
  ${plannerFine(insp, today)}
</div></section>
${sourcesBand(insp, "Sources", (insp?.sources ?? []).filter((s) => used.has(s.id)))}`;
}

/** iCalendar text for one state: its own entries plus national ones. Dated
 *  entries only (an entry "to be confirmed" has no day to put in a calendar). */
export function icsFor({ cal }, state, { today = new Date(), origin, brand } = {}) {
  const t = isoDay(today);
  const fold = (line) => line.replace(/(.{73})/g, "$1\r\n ").replace(/\r\n $/, "");
  const txt = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  const d8 = (iso) => iso.replace(/-/g, "");
  const next = (iso) => isoDay(new Date(dt(iso).getTime() + 86_400_000));
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const events = (cal?.events ?? []).filter((e) => e.date && (e.end || e.date) >= t && (statesOf(e)[0] === "ALL" || e.states.includes(state)));
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:-//${brand}//Planning calendar//EN`, "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${txt(`${brand} planning calendar (${state})`)}`, "X-WR-TIMEZONE:Australia/Melbourne", "REFRESH-INTERVAL;VALUE=DURATION:P7D"];
  for (const e of events) {
    const src = (cal.sources ?? []).find((s) => s.id === e.source);
    const uid = `${d8(e.date)}-${e.category}-${e.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}-${statesAttr(e).toLowerCase().replace(/ /g, "")}@${new URL(origin).host}`;
    lines.push("BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${d8(e.date)}`, `DTEND;VALUE=DATE:${d8(next(e.end || e.date))}`,
      `SUMMARY:${txt(`${e.title} (${CATEGORIES[e.category]})`)}`,
      `DESCRIPTION:${txt([statesLabel(e), e.location, e.note, src ? `Source: ${src.publisher} ${src.url}` : ""].filter(Boolean).join("\n"))}`,
      ...(e.location ? [`LOCATION:${txt(e.location)}`] : []), `CATEGORIES:${txt(CATEGORIES[e.category])}`, "TRANSP:TRANSPARENT", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
