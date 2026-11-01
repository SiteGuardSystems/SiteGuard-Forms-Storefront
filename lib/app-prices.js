// Reads the SiteGuard App price list (Dan's decision #90: one price source).
// data/app-catalogue.json is the catalogue's group "app", written by Hseq-Dev
// docs/build_catalogue.py (docs/pricing/export_price_tables.py --storefront)
// from docs/pricing/app_price_table.json; pricing.lock pins its public view and
// test/pricing-lock.test.js fails if this file drifts from it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateAppBilling } from "./app-billing.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const APP_CATALOGUE_PATH = path.join(ROOT, "data", "app-catalogue.json");
export const APP_BILLING_PATH = path.join(ROOT, "data", "app-billing.json");

export function readAppCatalogue(file = APP_CATALOGUE_PATH) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** data/app-billing.json validated, with the app catalogue's prices attached. */
export function loadAppBilling(configFile = APP_BILLING_PATH, catalogueFile = APP_CATALOGUE_PATH) {
  return validateAppBilling(JSON.parse(readFileSync(configFile, "utf8")), readAppCatalogue(catalogueFile));
}
