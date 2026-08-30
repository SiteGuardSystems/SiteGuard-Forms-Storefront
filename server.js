// SiteGuard FORMS storefront — deliberately small and separate from the
// Artifact Factory (internal ops tool). This process only ever talks to
// Stripe and a local orders/leads log; it never touches SharePoint, the
// Graph credentials, or the factory database.
import "dotenv/config";
import { readFile, appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import Stripe from "stripe";

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

async function loadCatalog() {
  const raw = await readFile(path.join(__dirname, "packages.json"), "utf8");
  return JSON.parse(raw);
}

async function appendJsonLine(file, record) {
  await mkdir(VAR_DIR, { recursive: true });
  await appendFile(
    path.join(VAR_DIR, file),
    JSON.stringify({ ...record, at: new Date().toISOString() }) + "\n",
    "utf8",
  );
}

const app = express();

// Stripe webhook needs the raw body for signature verification — must be
// registered before express.json() touches the request.
app.post(
  "/api/webhook/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!stripe || !stripeWebhookSecret) {
      return res.status(501).json({ ok: false, reason: "Stripe not configured" });
    }
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        stripeWebhookSecret,
      );
    } catch (err) {
      return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      await appendJsonLine("orders.jsonl", {
        event: "checkout.session.completed",
        sessionId: session.id,
        packageId: session.metadata?.packageId ?? null,
        customerEmail: session.customer_details?.email ?? null,
        amountTotal: session.amount_total,
        currency: session.currency,
      });
      // TODO(fulfillment): this is the extension point for actually delivering
      // the purchased document(s) — e.g. emailing a signed download link
      // sourced from the QA-clean library, or granting access in a customer
      // portal. Deliberately not built yet: needs a decision on delivery
      // mechanism and confirmation the specific document is QA-clean before
      // being handed to a paying customer.
    }

    res.json({ received: true });
  },
);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/packages", async (_req, res) => {
  const catalog = await loadCatalog();
  res.json({ ...catalog, stripeConfigured: Boolean(stripe) });
});

app.post("/api/checkout", async (req, res) => {
  const { packageId } = req.body ?? {};
  if (!packageId) {
    return res.status(400).json({ ok: false, reason: "packageId is required" });
  }
  const catalog = await loadCatalog();
  const item = catalog.items.find((i) => i.id === packageId);
  if (!item) {
    return res.status(404).json({ ok: false, reason: "unknown packageId" });
  }
  if (item.tier === "quote") {
    return res
      .status(409)
      .json({ ok: false, reason: "This package is quote-based — submit the enquiry form instead." });
  }
  if (!stripe) {
    return res.status(501).json({
      ok: false,
      reason: "Stripe is not configured yet on this deployment (STRIPE_SECRET_KEY unset).",
    });
  }

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: catalog.currency,
          unit_amount: item.unit_amount,
          product_data: { name: item.name, description: item.tagline },
        },
        quantity: 1,
      },
    ],
    metadata: { packageId: item.id },
    success_url: `${PUBLIC_ORIGIN}/?checkout=success&package=${item.id}`,
    cancel_url: `${PUBLIC_ORIGIN}/?checkout=cancelled&package=${item.id}`,
  });

  res.json({ ok: true, url: session.url });
});

app.post("/api/lead", async (req, res) => {
  const { name, email, company, role, need, notes } = req.body ?? {};
  if (!name || !email) {
    return res.status(400).json({ ok: false, reason: "name and email are required" });
  }
  await appendJsonLine("leads.jsonl", { name, email, company, role, need, notes });
  res.json({ ok: true });
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "siteguard-forms-storefront", stripeConfigured: Boolean(stripe) });
});

app.listen(PORT, HOST, () => {
  console.log(`siteguard-forms-storefront listening on http://${HOST}:${PORT}`);
  console.log(`Stripe: ${stripe ? "configured" : "NOT configured — checkout returns 501, buy buttons fall back to the enquiry form"}`);
});
