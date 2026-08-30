// Project-credit ledger for subscriptions and one-time "N project" packs.
//
// Deliberately storefront-local, JSON-file-based, and holds real customer
// personal data (email, and — once redeemed — project address/client name).
// This MUST stay siloed from the Artifact Factory's Postgres/SharePoint —
// that's a design requirement, not an oversight. Nothing in this file talks
// to the factory; a real database can replace the JSON files later without
// changing the shape of what's stored.
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

async function appendJsonLine(file, record) {
  await appendFile(file, JSON.stringify({ ...record, at: new Date().toISOString() }) + "\n", "utf8");
}

/**
 * @param {string} varDir - e.g. /srv/siteguard/forms-storefront/var. Same
 *   directory leads.jsonl/orders.jsonl already live in.
 */
export function createCreditsStore(varDir) {
  const balancesFile = path.join(varDir, "credit-balances.json");
  const eventsFile = path.join(varDir, "credit-events.jsonl");
  const redemptionsFile = path.join(varDir, "project-redemptions.jsonl");

  async function loadBalances() {
    return readJson(balancesFile, {});
  }

  async function saveBalances(balances) {
    await ensureDir(varDir);
    await writeFile(balancesFile, JSON.stringify(balances, null, 1) + "\n", "utf8");
  }

  return {
    /**
     * Adds credits for a customer+package (a purchase or a subscription
     * renewal). Keyed by stripeCustomerId so it's independent of which
     * device/browser they're on.
     */
    async grantCredits({ stripeCustomerId, email, packageId, amount, source, sourceId }) {
      await ensureDir(varDir);
      const balances = await loadBalances();
      const key = stripeCustomerId;
      const existing = balances[key] ?? { email, packages: {} };
      existing.email = email ?? existing.email;
      existing.packages[packageId] = (existing.packages[packageId] ?? 0) + amount;
      balances[key] = existing;
      await saveBalances(balances);
      await appendJsonLine(eventsFile, {
        type: "grant",
        stripeCustomerId,
        email,
        packageId,
        amount,
        source, // "project-pack" | "subscription-initial" | "subscription-renewal"
        sourceId, // checkout session id or invoice id, for audit/dedupe
      });
      return existing.packages[packageId];
    },

    async getBalance(stripeCustomerId) {
      const balances = await loadBalances();
      return balances[stripeCustomerId] ?? null;
    },

    /** Has this specific purchase/renewal already been granted? Webhooks can
     *  redeliver the same event — check before granting to avoid double-crediting. */
    async wasAlreadyGranted(sourceId) {
      let text;
      try {
        text = await readFile(eventsFile, "utf8");
      } catch (err) {
        if (err.code === "ENOENT") return false;
        throw err;
      }
      return text
        .trim()
        .split("\n")
        .filter(Boolean)
        .some((line) => {
          try {
            return JSON.parse(line).sourceId === sourceId;
          } catch {
            return false;
          }
        });
    },

    /** Spends one credit for packageId, and records the redemption details.
     *  Returns the new remaining balance, or throws if there's none left. */
    async redeemCredit({ stripeCustomerId, email, packageId, projectAddress, clientName, siteNotes }) {
      await ensureDir(varDir);
      const balances = await loadBalances();
      const existing = balances[stripeCustomerId];
      const remaining = existing?.packages?.[packageId] ?? 0;
      if (remaining <= 0) {
        const err = new Error("no credits remaining for this package");
        err.code = "NO_CREDITS";
        throw err;
      }
      existing.packages[packageId] = remaining - 1;
      await saveBalances(balances);
      await appendJsonLine(eventsFile, {
        type: "redeem",
        stripeCustomerId,
        packageId,
        amount: -1,
      });
      await appendJsonLine(redemptionsFile, {
        stripeCustomerId,
        email,
        packageId,
        projectAddress,
        clientName,
        siteNotes,
        status: "submitted",
        // TODO(fulfillment): this is where a real generation-trigger call
        // into the Artifact Factory would go, once the library is approved
        // to reach real clients. Deliberately not built yet — see
        // README.md. Until then this just records the request.
      });
      return existing.packages[packageId];
    },
  };
}
