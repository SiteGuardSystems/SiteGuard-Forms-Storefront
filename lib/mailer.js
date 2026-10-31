// Thin Resend client — plain fetch, no SDK dependency (consistent with how
// the rest of this codebase talks to external APIs). If unconfigured, send()
// is a safe no-op: callers should keep writing to their own JSONL log
// regardless, so an email outage never loses the underlying record.
const RESEND_API_URL = "https://api.resend.com/emails";

export function createMailer({ apiKey, fromAddress, fetchImpl = fetch }) {
  const configured = Boolean(apiKey && fromAddress);

  return {
    configured,
    /** @returns {Promise<{ok: true, id: string} | {ok: false, reason: string}>} */
    async send({ to, subject, html, text }) {
      if (!configured) {
        return { ok: false, reason: "mailer not configured (RESEND_API_KEY/RESEND_FROM_EMAIL unset)" };
      }
      try {
        const res = await fetchImpl(RESEND_API_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ from: fromAddress, to, subject, html, text }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          return { ok: false, reason: `Resend ${res.status}: ${body.message ?? "send failed"}` };
        }
        return { ok: true, id: body.id };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const BRAND_HEADER = `<div style="font-family:'Helvetica Neue',Arial,sans-serif;color:#313035;">
  <p style="font-weight:700;font-size:1.1rem;margin:0 0 1.5rem;">SiteGuard <span style="color:#FB811C;">FORMS</span></p>`;
const BRAND_FOOTER = `<p style="color:#5C5A61;font-size:0.8rem;margin-top:2rem;">SiteGuard Systems · ABN 36 765 797 871 · Melbourne, Victoria</p></div>`;

// The support mailbox for customer replies. Set SUPPORT_EMAIL once the
// support address exists; until then replies go to the existing address.
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "hello@siteguardsystems.com.au";

/**
 * Sent once, right after a paid order comes through -- the payment receipt,
 * not the delivery. The actual documents follow separately once a human has
 * reviewed the parked order and run docs/send_order.py (hseq-dev) -- this
 * email sets that expectation (minutes, or one business day if checked) and gives a
 * support contact to chase if that doesn't happen, rather than leaving a
 * paying customer with only "we'll be in touch" and no recourse.
 */
export function orderReceivedEmail({ packageName, projectAddress, siteName }) {
  const subject = `Order received — ${escapeHtml(packageName)}`;
  const html = `${BRAND_HEADER}
    <p>Thanks for your order — <strong>${escapeHtml(packageName)}</strong>, for:</p>
    <p style="color:#4A484F;">${siteName ? `${escapeHtml(siteName)}<br/>` : ""}${escapeHtml(projectAddress)}</p>
    <p>Your documents are being prepared with the details you gave us and will arrive in a separate email within one business day, and often within minutes.</p>
    <p>Haven't received them within one business day? Contact <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> and we'll sort it out.</p>
    ${BRAND_FOOTER}`;
  const text = `Thanks for your order — ${packageName}, for: ${siteName ? `${siteName}, ` : ""}${projectAddress}\n\nYour documents are being prepared with the details you gave us and will arrive in a separate email within one business day, and often within minutes.\n\nHaven't received them within one business day? Contact ${SUPPORT_EMAIL} and we'll sort it out.`;
  return { subject, html, text };
}

function formatAud(cents) {
  if (cents == null) return "—";
  return `$${(cents / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Sent to SiteGuard internally, once per completed order, right alongside
 * the customer's own confirmation. This is the only automatic signal that
 * an order needs action — CRM entry, manual document delivery, and (per
 * Dan) support follow-up and quality tracking all start from this email
 * until there's a real admin queue to work from instead.
 */
export function adminOrderNotificationEmail({
  items,
  customerEmail,
  clientName,
  projectAddress,
  siteName,
  siteNotes,
  amountTotal,
  currency,
  sessionId,
  parkResult,
}) {
  const subject = `New order — ${escapeHtml(clientName)} (${formatAud(amountTotal)})`;
  const itemRowsHtml = items
    .map((i) => `<li>${escapeHtml(i.name)} — ${formatAud(i.amountTotal)}</li>`)
    .join("");
  const itemRowsText = items.map((i) => `- ${i.name} — ${formatAud(i.amountTotal)}`).join("\n");

  // Whatever actually got retrieved and parked for review -- clean, failed,
  // or not configured at all. Never silent: if this isn't a straight
  // "ready to review" case, the email says exactly why, loud, at the top.
  let parkHtml;
  let parkText;
  if (!parkResult) {
    parkHtml = `<p style="color:#A3261A;"><strong>Documents not retrieved</strong> — pull this order's files by hand.</p>`;
    parkText = "Documents not retrieved — pull this order's files by hand.";
  } else if (parkResult.ok) {
    parkHtml = `<p style="color:#2E7D32;"><strong>Documents retrieved and parked for review:</strong><br/>
      <span style="font-family:monospace;">${escapeHtml(parkResult.dir ?? "")}</span></p>`;
    parkText = `Documents retrieved and parked for review:\n${parkResult.dir ?? ""}`;
  } else {
    const issues = (parkResult.groups ?? [])
      .flatMap((g) => [...(g.hash_mismatches ?? []), ...(g.missing_source_files ?? [])]);
    parkHtml = `<p style="color:#A3261A;"><strong>Document retrieval needs attention</strong> — ${escapeHtml(parkResult.reason ?? "see park-order-events.jsonl")}${issues.length ? `<br/>Affected codes: ${escapeHtml(issues.join(", "))}` : ""}${parkResult.dir ? `<br/>Partial output: <span style="font-family:monospace;">${escapeHtml(parkResult.dir)}</span>` : ""}</p>`;
    parkText = `Document retrieval needs attention — ${parkResult.reason ?? "see park-order-events.jsonl"}${issues.length ? `\nAffected codes: ${issues.join(", ")}` : ""}${parkResult.dir ? `\nPartial output: ${parkResult.dir}` : ""}`;
  }

  const html = `${BRAND_HEADER}
    <p style="font-weight:700;">New order received</p>
    <ul>${itemRowsHtml}</ul>
    <p><strong>Total:</strong> ${formatAud(amountTotal)} ${escapeHtml((currency ?? "").toUpperCase())}</p>
    <p><strong>Client:</strong> ${escapeHtml(clientName)}<br/>
    <strong>Project address:</strong> ${escapeHtml(projectAddress)}<br/>
    ${siteName ? `<strong>Site name:</strong> ${escapeHtml(siteName)}<br/>` : ""}
    <strong>Customer email:</strong> ${escapeHtml(customerEmail)}<br/>
    ${siteNotes ? `<strong>Site notes:</strong> ${escapeHtml(siteNotes)}<br/>` : ""}
    <strong>Stripe session:</strong> ${escapeHtml(sessionId)}</p>
    ${parkHtml}
    ${BRAND_FOOTER}`;

  const text = [
    "New order received",
    ...itemRowsText.split("\n"),
    `Total: ${formatAud(amountTotal)} ${(currency ?? "").toUpperCase()}`,
    `Client: ${clientName}`,
    `Project address: ${projectAddress}`,
    siteName ? `Site name: ${siteName}` : null,
    `Customer email: ${customerEmail}`,
    siteNotes ? `Site notes: ${siteNotes}` : null,
    `Stripe session: ${sessionId}`,
    "",
    parkText,
  ]
    .filter(Boolean)
    .join("\n");

  return { subject, html, text };
}

/** Internal alert for a website enquiry (both sites post to /api/lead). */
export function leadNotificationEmail({ source, name, email, company, phone, need, enquiry_type, ref, partner_url, partner_kind }) {
  const site = source === "systems" ? "siteguardsystems.com.au" : "siteguardforms.com.au";
  const partner = enquiry_type === "partner";
  // The subject keeps the "Website enquiry —" prefix: the CRM's inbox triage
  // (siteguard-ai growth.parse_lead_notification) keys on it.
  const subject = `Website enquiry — ${partner ? "Partner application — " : ""}${escapeHtml(name)}${company ? ` (${escapeHtml(company)})` : ""}`;
  const KIND = { referral: "Referral partner", affiliate: "Affiliate", alliance: "Supplier or service alliance" };
  const extra = [
    partner ? ["Enquiry type", "Partner application"] : null,
    partner && partner_kind ? ["Partner kind", KIND[partner_kind] ?? partner_kind] : null,
    partner && partner_url ? ["Partner website", partner_url] : null,
    ref ? ["Referral code", ref] : null,
  ].filter(Boolean);
  const html = `${BRAND_HEADER}
    <p style="font-weight:700;">New ${partner ? "partner application" : "enquiry"} from ${site}</p>
    <p><strong>Name:</strong> ${escapeHtml(name)}<br/>
    <strong>Email:</strong> ${escapeHtml(email)}<br/>
    ${company ? `<strong>Company:</strong> ${escapeHtml(company)}<br/>` : ""}
    ${phone ? `<strong>Phone:</strong> ${escapeHtml(phone)}<br/>` : ""}
    ${extra.map(([k, v]) => `<strong>${k}:</strong> ${escapeHtml(v)}<br/>`).join("")}</p>
    <p style="white-space:pre-wrap;">${escapeHtml(need)}</p>
    ${BRAND_FOOTER}`;
  // "New enquiry from <site>" stays the first line for the same reason.
  const text = [`New enquiry from ${site}`, `Name: ${name}`, `Email: ${email}`,
    company ? `Company: ${company}` : null, phone ? `Phone: ${phone}` : null,
    ...extra.map(([k, v]) => `${k}: ${v}`), "", need].filter((x) => x !== null).join("\n");
  return { subject, html, text };
}
