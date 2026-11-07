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
 * not the delivery. Go-live 7 Nov 2026 (manual delivery): the documents are
 * prepared and checked by hand, and delivered as PDFs by email within the
 * delivery SLA (3 business days by default, forms.delivery_sla_business_days),
 * counted from when the buyer's details are in. FORMS returns one intake link
 * per order line (`intakeUrl`); each is listed here so the buyer can send
 * their details straight away. No link (FORMS not reached, or a redelivery)
 * means the FORMS order confirmation email carries it instead.
 */
export function orderReceivedEmail({ packageName, projectAddress, siteName, intakeLinks = [], slaDays = 3 }) {
  const days = Number.isInteger(slaDays) && slaDays >= 1 && slaDays <= 10 ? slaDays : 3;
  const links = (intakeLinks ?? []).filter((l) => l && /^https?:\/\/[^\s"<>]+$/.test(l.url ?? ""));
  const subject = `Order received — ${escapeHtml(packageName)}`;
  const delivery = `Your documents are delivered as PDFs by email within ${days} business days. The ${days}-business-day clock starts when your details are in.`;
  const linkIntro = links.length
    ? "Next step: tell us your business and project details, so we can prepare your documents."
    : "Next step: tell us your business and project details. The link to the short details form is in your order confirmation email from SiteGuard FORMS.";
  const html = `${BRAND_HEADER}
    <p>Thanks for your order — <strong>${escapeHtml(packageName)}</strong>, for:</p>
    <p style="color:#4A484F;">${siteName ? `${escapeHtml(siteName)}<br/>` : ""}${escapeHtml(projectAddress)}</p>
    <p>${linkIntro}</p>
    ${links.map((l) => `<p><a href="${escapeHtml(l.url)}" style="display:inline-block;background:#F7931E;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Enter your details${links.length > 1 && l.name ? `: ${escapeHtml(l.name)}` : ""}</a></p>`).join("\n    ")}
    <p>${delivery}</p>
    <p>Questions, or haven't received the details form? Contact <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> and we'll sort it out.</p>
    ${BRAND_FOOTER}`;
  const text = [
    `Thanks for your order — ${packageName}, for: ${siteName ? `${siteName}, ` : ""}${projectAddress}`,
    linkIntro,
    ...links.map((l) => `${links.length > 1 && l.name ? `${l.name}: ` : ""}${l.url}`),
    delivery,
    `Questions, or haven't received the details form? Contact ${SUPPORT_EMAIL} and we'll sort it out.`,
  ].join("\n\n");
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
export function leadNotificationEmail({ source, name, email, company, phone, need, enquiry_type, ref, partner_url, partner_kind, interest, trade, consent_basis, consent_method, consent_wording, consent_source, consent_at }) {
  // One line per field, "Label: value", for the CRM's lead parser (siteguard-ai
  // growth.parse_lead_notification). Values are kept to a single line.
  const one = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
  const site = source === "systems" ? "siteguardsystems.com.au" : "siteguardforms.com.au";
  const partner = enquiry_type === "partner";
  const formsInterest = enquiry_type === "forms-interest";
  const interestLead = enquiry_type === "app-interest" || formsInterest;
  const INTEREST = formsInterest
    ? { subscriptions: "FORMS subscriptions", consultant_plans: "FORMS consultant plans", both: "FORMS subscriptions and consultant plans" }
    : { app: "SiteGuard App", audit: "SiteGuard Audit", both: "SiteGuard App and SiteGuard Audit" };
  // The subject keeps the "Website enquiry —" prefix: the CRM's inbox triage
  // (siteguard-ai growth.parse_lead_notification) keys on it.
  const subject = `Website enquiry — ${partner ? "Partner application — " : interestLead ? "Registered interest — " : ""}${escapeHtml(name)}${company ? ` (${escapeHtml(company)})` : ""}`;
  const KIND = { referral: "Referral partner", affiliate: "Affiliate", alliance: "Supplier or service alliance" };
  const extra = [
    partner ? ["Enquiry type", "Partner application"] : null,
    interestLead ? ["Enquiry type", formsInterest ? "FORMS interest" : "App interest"] : null,
    interestLead ? ["Interest", INTEREST[interest] ?? interest] : null,
    interestLead && trade ? ["Trade or business", trade] : null,
    interestLead ? ["Consent basis", one(consent_basis) || "enquiry"] : null,
    interestLead ? ["Consent method", one(consent_method) || "website form"] : null,
    interestLead && one(consent_wording) ? ["Consent wording", one(consent_wording)] : null,
    interestLead && one(consent_source) ? ["Consent source", one(consent_source)] : null,
    interestLead && one(consent_at) ? ["Consent at", one(consent_at)] : null,
    partner && partner_kind ? ["Partner kind", KIND[partner_kind] ?? partner_kind] : null,
    partner && partner_url ? ["Partner website", partner_url] : null,
    ref ? ["Referral code", ref] : null,
  ].filter(Boolean);
  const html = `${BRAND_HEADER}
    <p style="font-weight:700;">New ${partner ? "partner application" : interestLead ? "registered interest" : "enquiry"} from ${site}</p>
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
