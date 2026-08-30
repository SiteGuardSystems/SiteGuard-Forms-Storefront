// SiteGuard FORMS storefront — deliberately small and separate from the
// Artifact Factory (internal ops tool). This process only ever talks to
// Stripe and a local orders/leads log; it never touches SharePoint, the
// Graph credentials, or the factory database. The app itself lives in
// lib/create-app.js as a pure factory; this file just wires up real env,
// a real Stripe client, and listen().
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";
import { createApp } from "./lib/create-app.js";

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

const app = createApp({
  catalogPath: path.join(__dirname, "packages.json"),
  varDir: VAR_DIR,
  publicDir: path.join(__dirname, "public"),
  stripe,
  stripeTestMode,
  stripeWebhookSecret,
  publicOrigin: PUBLIC_ORIGIN,
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
});
