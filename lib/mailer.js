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

/**
 * Sent once, right after a paid order comes through. There's deliberately no
 * "your documents are ready" follow-up template here yet — per
 * docs/ORDER_SITE.md, delivery is manual until the cloud migration, so the
 * next email this customer gets is from a person, not this codebase.
 */
export function orderReceivedEmail({ packageName, projectAddress }) {
  const subject = `Order received — ${escapeHtml(packageName)}`;
  const html = `${BRAND_HEADER}
    <p>Thanks for your order — <strong>${escapeHtml(packageName)}</strong>, for:</p>
    <p style="color:#4A484F;">${escapeHtml(projectAddress)}</p>
    <p>A member of the SiteGuard team reviews and masters every order before it's delivered — we'll be in touch shortly to confirm delivery.</p>
    ${BRAND_FOOTER}`;
  const text = `Thanks for your order — ${packageName}, for: ${projectAddress}\n\nA member of the SiteGuard team reviews and masters every order before it's delivered — we'll be in touch shortly to confirm delivery.`;
  return { subject, html, text };
}
