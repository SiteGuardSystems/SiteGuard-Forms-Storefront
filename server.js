// SiteGuard FORMS storefront — deliberately small and separate from the
// Artifact Factory (internal ops tool). This process only ever talks to
// Stripe, the Artifact Factory's narrow storefront-orders intake endpoint,
// and a local orders/leads log; it never touches SharePoint, the Graph
// credentials, or the factory database directly. The app itself lives in
// lib/create-app.js as a pure factory; this file just wires up real env, a
// real Stripe client, and listen().
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Backstop: an uncaught async error in a route handler used to take the
// whole process down (a Stripe validation error did exactly this once —
// see git history). Every route handler that talks to Stripe/the factory is
// now wrapped in its own try/catch, but this stays as a last line of
// defence so a future oversight logs loudly instead of silently killing the
// service and restarting into the same customer's next request.
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION — this should have been caught locally:", err);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION — this should have been caught locally:", err);
});
import Stripe from "stripe";
import { createApp } from "./lib/create-app.js";
import { createMailer } from "./lib/mailer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VAR_DIR = process.env.SITEGUARD_FORMS_VAR_DIR ?? path.join(__dirname, "var");
const PORT = Number(process.env.PORT ?? 4300);
const HOST = process.env.HOST ?? "0.0.0.0";

// The domain this will live at once DNS/hosting are pointed at it. Used to
// build Stripe's success/cancel redirect URLs. Override in .env for local
// testing (e.g. http://192.168.0.167:4300) — see .env.example.
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN ?? "https://www.siteguardforms.com.au";

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;

// sk_test_... vs sk_live_... — surfaced to the page so a test-mode deployment
// says so out loud. No real card is ever charged against a test key, but the
// checkout page looks identical either way, so this is the only visible cue.
const stripeTestMode = Boolean(stripeSecretKey?.startsWith("sk_test_"));
if (stripeSecretKey && !stripeTestMode && !stripeSecretKey.startsWith("sk_live_")) {
  console.warn("STRIPE_SECRET_KEY doesn't look like sk_test_... or sk_live_... — double-check it.");
}

// Until siteguardforms.com.au's DNS is verified with Resend, RESEND_FROM_EMAIL
// should be Resend's shared onboarding@resend.dev sender — real domain
// sending needs the DNS records Resend's dashboard provides after "Add Domain".
const mailer = createMailer({
  apiKey: process.env.RESEND_API_KEY,
  fromAddress: process.env.RESEND_FROM_EMAIL,
});
if (!mailer.configured) {
  console.warn("RESEND_API_KEY/RESEND_FROM_EMAIL not set — order confirmations aren't emailed, only logged to var/mail-events.jsonl.");
}

// Internal order alert — CRM entry, manual delivery, support and quality
// tracking all start from this email until there's a real admin queue.
const ADMIN_NOTIFICATION_EMAIL = process.env.ADMIN_NOTIFICATION_EMAIL;
if (!ADMIN_NOTIFICATION_EMAIL) {
  console.warn("ADMIN_NOTIFICATION_EMAIL not set — no internal alert is sent when an order comes in.");
}

// SiteGuard-Forms' narrow storefront-orders intake route (see
// server/routes.ts there, requireStorefrontApiKey). Shared secret, not the
// same credential as anything Graph/SharePoint-related. Was the Artifact
// Factory's storefront-orders route until 2026-09-05's consolidation
// workstream 4 -- same shape, new destination.
const ORDER_INTAKE_URL = process.env.ORDER_INTAKE_URL;
const ORDER_INTAKE_API_KEY = process.env.ORDER_INTAKE_API_KEY;
if (!ORDER_INTAKE_URL || !ORDER_INTAKE_API_KEY) {
  console.warn("ORDER_INTAKE_URL/API_KEY not set — orders complete and are logged, but nothing is recorded for review.");
}

// Retrieves and parks a completed order's real files on the library host for
// Dan to review before sending — per his 2026-10-04 decision, delivery stays
// manual for now; this only gets the right files in front of him faster.
// The SSH key here is forced to exactly one remote command (see ai-control's
// authorized_keys) — this process can trigger a park, nothing else.
const PARK_ORDER_HOST = process.env.PARK_ORDER_HOST;
const PARK_ORDER_USER = process.env.PARK_ORDER_USER;
const PARK_ORDER_SSH_KEY_PATH = process.env.PARK_ORDER_SSH_KEY_PATH;
const parkOrder =
  PARK_ORDER_HOST && PARK_ORDER_USER && PARK_ORDER_SSH_KEY_PATH
    ? { host: PARK_ORDER_HOST, user: PARK_ORDER_USER, keyPath: PARK_ORDER_SSH_KEY_PATH }
    : undefined;
if (!parkOrder) {
  console.warn("PARK_ORDER_HOST/USER/SSH_KEY_PATH not set — orders are recorded but documents aren't auto-retrieved for review.");
}

const app = createApp({
  catalogPath: path.join(__dirname, "packages.json"),
  individualDocsPath: path.join(__dirname, "individual-documents.json"),
  varDir: VAR_DIR,
  publicDir: path.join(__dirname, "public"),
  stripe,
  stripeTestMode,
  stripeWebhookSecret,
  publicOrigin: PUBLIC_ORIGIN,
  mailer,
  adminNotificationEmail: ADMIN_NOTIFICATION_EMAIL,
  orderIntakeUrl: ORDER_INTAKE_URL,
  orderIntakeApiKey: ORDER_INTAKE_API_KEY,
  parkOrder,
});

app.listen(PORT, HOST, () => {
  console.log(`siteguard-forms-storefront listening on http://${HOST}:${PORT}`);
  if (!stripe) {
    console.log("Stripe: NOT configured — checkout returns 501, buy buttons fall back to the enquiry form");
  } else if (stripeTestMode) {
    console.log("Stripe: TEST MODE (sk_test_...) — no real card will be charged");
    if (!stripeWebhookSecret) {
      console.log("  webhook: not configured — checkout completes and redirects fine, but orders.jsonl won't get an entry until a webhook is wired up");
    }
  } else {
    console.log("Stripe: LIVE MODE (sk_live_...) — real cards will be charged");
  }
  console.log(mailer.configured ? `Mail: Resend configured (from ${process.env.RESEND_FROM_EMAIL})` : "Mail: NOT configured — logged to file only");
  console.log(
    ORDER_INTAKE_URL && ORDER_INTAKE_API_KEY
      ? `Order intake: orders recorded for review at ${ORDER_INTAKE_URL}`
      : "Order intake: NOT configured — orders are logged locally only, nothing recorded for review",
  );
  console.log(
    parkOrder
      ? `Park order: documents auto-retrieved to ${parkOrder.user}@${parkOrder.host} for review`
      : "Park order: NOT configured — documents aren't auto-retrieved, pull them by hand",
  );
});
