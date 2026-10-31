// The optional "Site name" from the cart page (Dan, 31 Oct 2026: "Storefront: optional site-name
// field at checkout, passed through to Forms SITE_NAME"). Forms prints it in <<SITE_NAME>>; left
// empty, the documents print a blank line to write on.
//
// The same rule runs in SiteGuard-Forms (app/shared/site-name.ts), which cleans it again at the
// intake. Keep the two in step.
//
// Plain text only: tags are dropped, then any stray angle bracket, then control characters;
// whitespace collapses to single spaces, and the result is trimmed and clipped. HTML escaping
// happens where it's printed into HTML (lib/mailer.js escapeHtml). Never a reason to refuse an
// order: anything that isn't a non-empty string after cleaning is null.

export const SITE_NAME_MAX = 100;

export function normaliseSiteName(raw) {
  if (typeof raw !== "string") return null;
  const clean = raw
    .replace(/<[^>]*>/g, " ")
    .replace(/[<>]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SITE_NAME_MAX)
    .trim();
  return clean || null;
}
