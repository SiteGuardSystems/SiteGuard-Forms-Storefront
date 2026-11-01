// Pays an open Stripe-hosted Checkout page in a headless browser with Stripe's
// test card (4242 4242 4242 4242). TEST MODE ONLY: the caller must hold a
// sk_test_ key; a live checkout page refuses test cards anyway.
export async function payHostedCheckout(browser, url, {
  email = "delivered@resend.dev",
  name = "SiteGuard E2E Test",
  customFields = {},
  address = { line1: "1 Test Street", city: "Sydney", postcode: "2000", state: "NSW" },
  successUrlPrefix,
  screenshotPath,
} = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
  try {
    await page.goto(url);
    await page.waitForSelector('button[type="submit"]', { timeout: 45_000 });
    // An existing customer's email is shown read-only.
    if (await page.locator("#email").isVisible().catch(() => false)) await page.fill("#email", email);
    for (const [key, value] of Object.entries(customFields)) await page.fill(`input[name="${key}"]`, value);
    if (!(await page.locator("#cardNumber").isVisible().catch(() => false))) {
      // Several payment methods: open Card (the accordion button is visually hidden, so dispatch the click).
      await page.waitForTimeout(3000);
      if (!(await page.locator("#cardNumber").isVisible().catch(() => false))) {
        await page.locator('[data-testid="card-accordion-item-button"]').dispatchEvent("click").catch(() => {});
      }
    }
    await page.waitForSelector("#cardNumber", { timeout: 20_000 });
    await page.fill("#cardNumber", "4242424242424242");
    await page.fill("#cardExpiry", "12 / 34");
    await page.fill("#cardCvc", "123");
    await page.fill("#billingName", name);
    const country = page.locator("#billingCountry");
    if (await country.count()) await country.selectOption("AU");
    const manual = page.getByText("Enter address manually");
    if (await manual.count()) await manual.first().click().catch(() => {});
    await page.fill("#billingAddressLine1", address.line1);
    await page.fill("#billingLocality", address.city);
    await page.fill("#billingPostalCode", address.postcode);
    const state = page.locator("#billingAdministrativeArea");
    if (await state.count()) await state.selectOption(address.state);
    // Stripe Link may offer to save details; never opt in.
    const link = page.locator("#enableStripePass");
    if (await link.count() && (await link.isChecked().catch(() => false))) await link.uncheck().catch(() => {});
    await page.waitForTimeout(1500); // let Stripe Tax recalculate on the address
    const totalText = (await page.locator("body").innerText()).match(/Total due\s*A\$([\d,]+\.\d\d)/)?.[1] ?? null;
    if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true });
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.toString().startsWith(successUrlPrefix), { timeout: 90_000 });
    return { ok: true, totalShown: totalText };
  } finally {
    await page.close();
  }
}
