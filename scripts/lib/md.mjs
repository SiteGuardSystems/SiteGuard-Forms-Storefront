// Minimal Markdown for the legal sources (SiteGuard-Forms app/server/data/legal).
// Supports what those files use: front matter, ### / #### headings, paragraphs,
// bullet lists (one nested level), block quotes, pipe tables, **bold**, *italic*
// and [links](url). No raw HTML is passed through: everything is escaped.

export function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Bracketed placeholders still to be filled in, e.g. "[ABN]" (not links). */
export const PLACEHOLDER_RE = /\[[^\]\n]+\](?!\()/g;

export function frontMatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^"(.*)"$/, "$1");
  }
  return { meta, body: text.slice(m[0].length) };
}

function inline(s, { linkMap = {}, markPlaceholders = true } = {}) {
  let out = esc(s);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => {
    const target = linkMap[href] ?? href;
    if (!/^(https?:|mailto:|\/|#)/.test(target)) return text; // relative asset links: text only
    return `<a href="${target}">${text}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  if (markPlaceholders) {
    out = out.replace(/\[([^\]<>]+)\](?!\()/g, '<mark class="placeholder">[$1]</mark>');
  }
  return out;
}

export function render(body, opts = {}) {
  const lines = body.replace(/\r/g, "").split("\n");
  const html = [];
  let i = 0;
  const shift = opts.headingShift ?? 1; // "###" in the sources becomes <h2>
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = Math.min(6, Math.max(2, h[1].length - shift));
      html.push(`<h${level}>${inline(h[2], opts)}</h${level}>`);
      i++; continue;
    }
    if (/^\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i++; }
      const cells = (r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(rows[0]);
      const bodyRows = rows.slice(1).filter((r) => !/^\|[\s:|-]+\|?$/.test(r));
      html.push('<div class="table-scroll"><table class="doc-table"><thead><tr>' +
        head.map((c) => `<th scope="col">${inline(c, opts)}</th>`).join("") + "</tr></thead><tbody>" +
        bodyRows.map((r) => "<tr>" + cells(r).map((c) => `<td>${inline(c, opts)}</td>`).join("") + "</tr>").join("") +
        "</tbody></table></div>");
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^>\s?/, "")); i++; }
      html.push(`<div class="notice-box">${render(quote.join("\n"), opts)}</div>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const indent = lines[i].match(/^\s*/)[0].length;
        const text = lines[i].replace(/^\s*[-*]\s+/, "");
        if (indent >= 2 && items.length) items[items.length - 1].sub.push(text);
        else items.push({ text, sub: [] });
        i++;
      }
      html.push("<ul>" + items.map((it) =>
        `<li>${inline(it.text, opts)}${it.sub.length ? "<ul>" + it.sub.map((s) => `<li>${inline(s, opts)}</li>`).join("") + "</ul>" : ""}</li>`,
      ).join("") + "</ul>");
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\d+\.\s+/, "")); i++; }
      html.push("<ol>" + items.map((t) => `<li>${inline(t, opts)}</li>`).join("") + "</ol>");
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|>|\||\s*[-*]\s+|\d+\.\s+)/.test(lines[i])) {
      para.push(lines[i].trim()); i++;
    }
    html.push(`<p>${inline(para.join(" "), opts)}</p>`);
  }
  return html.join("\n");
}

/** Plain text (for meta descriptions). */
export function plain(body, max = 155) {
  const t = body.replace(/^[#>|-].*$/gm, " ").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(PLACEHOLDER_RE, "")
    .replace(/[*_]/g, "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).replace(/\s+\S*$/, "") + "…" : t;
}
