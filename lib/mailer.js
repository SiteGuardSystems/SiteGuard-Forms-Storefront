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
const BRAND_FOOTER = `<p style="color:#5C5A61;font-size:0.8rem;margin-top:2rem;">SiteGuard Systems · Melbourne, Victoria</p></div>`;

export function creditsGrantedEmail({ packageName, credits, redeemUrl }) {
  const subject = `Your ${escapeHtml(packageName)} project credits are ready`;
  const html = `${BRAND_HEADER}
    <p>You now have <strong>${credits}</strong> project credit(s) for <strong>${escapeHtml(packageName)}</strong>.</p>
    <p>Use the link below whenever you're ready to submit a project's details (site address, client name) and we'll prepare your controlled documents for it.</p>
    <p><a href="${redeemUrl}" style="background:#FB811C;color:#fff;padding:0.6rem 1.2rem;border-radius:4px;text-decoration:none;font-weight:700;">Submit a Project</a></p>
    <p style="color:#5C5A61;font-size:0.85rem;">This link is valid for 7 days and can be reused to check your remaining balance or submit another project.</p>
    ${BRAND_FOOTER}`;
  const text = `You now have ${credits} project credit(s) for ${packageName}.\n\nSubmit a project: ${redeemUrl}\n\nThis link is valid for 7 days.`;
  return { subject, html, text };
}

export function redemptionReceivedEmail({ packageName, projectAddress, remaining }) {
  const subject = `Project received — ${escapeHtml(packageName)}`;
  const html = `${BRAND_HEADER}
    <p>We've received your project details for <strong>${escapeHtml(packageName)}</strong>:</p>
    <p style="color:#4A484F;">${escapeHtml(projectAddress)}</p>
    <p>A member of the SiteGuard team reviews every project before documents are finalised and delivered — we'll be in touch shortly.</p>
    <p style="color:#5C5A61;font-size:0.85rem;">Remaining credits for this package: ${remaining}.</p>
    ${BRAND_FOOTER}`;
  const text = `We've received your project details for ${packageName}: ${projectAddress}\n\nA member of the SiteGuard team reviews every project before documents are finalised and delivered — we'll be in touch shortly.\n\nRemaining credits: ${remaining}.`;
  return { subject, html, text };
}
