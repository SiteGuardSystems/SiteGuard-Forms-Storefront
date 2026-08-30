// SiteGuard FORMS — landing page behaviour. No framework: this page's job is
// to render a catalog, take payment or a lead, and get out of the way.

const grid = document.getElementById("package-grid");
let stripeConfigured = false;
let stripeTestMode = false;

async function loadPackages() {
  try {
    const res = await fetch("/api/packages");
    const catalog = await res.json();
    stripeConfigured = Boolean(catalog.stripeConfigured);
    stripeTestMode = Boolean(catalog.stripeTestMode);
    showTestModeBanner();
    renderCatalog(catalog.categories ?? []);
  } catch {
    grid.innerHTML = `<p class="loading">Couldn't load packages right now — please try again shortly.</p>`;
  }
}

function showTestModeBanner() {
  if (!stripeTestMode) return;
  const banner = document.getElementById("checkout-banner");
  // Only overrides the ?checkout= banner if nothing else has claimed it yet.
  if (!banner.hidden) return;
  banner.hidden = false;
  banner.className = "banner test-mode";
  banner.textContent =
    "TEST MODE — Stripe test key active, no real card is charged. Use card 4242 4242 4242 4242, any future date, any CVC.";
}

// Merges each category's _itemDefaults into its items — mirrors the same
// merge the server does when flattening for checkout, so a category like
// SWMS can define "coming-soon" / "Notify Me" once for 21 trades instead of
// repeating it.
function withDefaults(category) {
  const defaults = category._itemDefaults ?? {};
  return (category.items ?? []).map((item) => ({ ...defaults, ...item }));
}

/** Resolve the actual purchasability of an item: self-serve only counts as
 *  buyable when Stripe is actually configured on this deployment. */
function resolvedState(item) {
  if (item.tier === "quote") return "quote";
  if (item.tier === "coming-soon") return "coming-soon";
  return stripeConfigured ? "self-serve" : "coming-soon";
}

function renderCatalog(categories) {
  grid.innerHTML = "";
  for (const category of categories) {
    const section = document.createElement("div");
    section.className = "category-block";
    section.innerHTML = `
      <h3 class="category-name">${escapeHtml(category.name)}</h3>
      ${category.description ? `<p class="category-desc">${escapeHtml(category.description)}</p>` : ""}
    `;
    const items = withDefaults(category);
    section.appendChild(
      category.layout === "chips" ? renderChipGrid(items) : renderCardGrid(items),
    );
    grid.appendChild(section);
  }
}

const OPTION_ORDER = ["pdf", "projectPack", "subscription"];
const DEFAULT_OPTION = "projectPack";

function renderCardGrid(items) {
  const container = document.createElement("div");
  container.className = "package-grid";
  for (const item of items) {
    const state = resolvedState(item);
    const card = document.createElement("article");
    card.className = `package-card tier-${state}`;

    const bullets = (item.bullets ?? []).map((b) => `<li>${escapeHtml(b)}</li>`).join("");
    const label =
      state === "quote" ? (item.cta ?? "Request Quote") : state === "coming-soon" ? "Coming Soon" : (item.cta ?? "Buy Now");

    const hasOptions = state === "self-serve" && item.purchaseOptions;
    const optionKeys = hasOptions ? OPTION_ORDER.filter((k) => item.purchaseOptions[k]) : [];
    const initialOption = optionKeys.includes(DEFAULT_OPTION) ? DEFAULT_OPTION : optionKeys[0];
    const initialPricing = hasOptions ? item.purchaseOptions[initialOption] : item;

    card.innerHTML = `
      <p class="package-name">${escapeHtml(item.name)}</p>
      <p class="package-tagline">${escapeHtml(item.tagline ?? "")}</p>
      ${
        hasOptions
          ? `<div class="option-tabs" role="tablist">${optionKeys
              .map(
                (key) =>
                  `<button type="button" class="option-tab${key === initialOption ? " active" : ""}" data-option="${key}">${escapeHtml(item.purchaseOptions[key].label)}</button>`,
              )
              .join("")}</div>`
          : ""
      }
      <p class="package-price" data-role="price">${escapeHtml(initialPricing.priceLabel ?? "")}</p>
      <p class="package-price-suffix" data-role="price-suffix">${escapeHtml(initialPricing.priceSuffix ?? "")}</p>
      <p data-role="option-desc">${escapeHtml(hasOptions ? initialPricing.description : item.description ?? "")}</p>
      <ul class="package-bullets">${bullets}</ul>
      <button class="btn ${state === "self-serve" ? "btn-primary" : "btn-ghost"} btn-block" data-role="buy">${escapeHtml(label)}</button>
      ${state === "coming-soon" ? `<p class="package-status">Not available for purchase yet — use the enquiry form below to be notified.</p>` : ""}
    `;

    let selectedOption = initialOption;
    if (hasOptions) {
      const tabs = [...card.querySelectorAll(".option-tab")];
      tabs.forEach((tab) =>
        tab.addEventListener("click", () => {
          selectedOption = tab.dataset.option;
          tabs.forEach((t) => t.classList.toggle("active", t === tab));
          const pricing = item.purchaseOptions[selectedOption];
          card.querySelector('[data-role="price"]').textContent = pricing.priceLabel ?? "";
          card.querySelector('[data-role="price-suffix"]').textContent = pricing.priceSuffix ?? "";
          card.querySelector('[data-role="option-desc"]').textContent = pricing.description ?? "";
        }),
      );
    }

    const button = card.querySelector('[data-role="buy"]');
    button.addEventListener("click", () => handlePackageAction(item, state, button, hasOptions ? selectedOption : null));
    container.appendChild(card);
  }
  return container;
}

/** Compact one-line-per-trade layout — 21 near-identical big cards would
 *  bury the actually-buyable categories above them. */
function renderChipGrid(items) {
  const container = document.createElement("div");
  container.className = "trade-chip-grid";
  for (const item of items) {
    const state = resolvedState(item);
    const chip = document.createElement("div");
    chip.className = `trade-chip tier-${state}`;
    chip.innerHTML = `
      <span class="trade-chip-name">${escapeHtml(item.trade ?? item.name ?? "")}</span>
      <button class="btn-chip">${escapeHtml(item.cta ?? "Notify Me")}</button>
    `;
    chip.querySelector("button").addEventListener("click", (e) =>
      handlePackageAction(item, state, e.currentTarget),
    );
    container.appendChild(chip);
  }
  return container;
}

async function handlePackageAction(item, state, button, option = null) {
  if (state !== "self-serve") {
    document.getElementById("enquire").scrollIntoView({ behavior: "smooth" });
    const need = document.querySelector('textarea[name="need"]');
    const label = item.trade ? `SWMS — ${item.trade}` : item.name;
    if (need && !need.value) {
      need.value = `Interested in: ${label}`;
    }
    return;
  }

  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "Redirecting to checkout…";

  try {
    const res = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ packageId: item.id, option }),
    });
    const data = await res.json();
    if (data.ok && data.url) {
      window.location.href = data.url;
      return;
    }
    alert(data.reason ?? "Checkout is unavailable right now.");
  } catch {
    alert("Checkout is unavailable right now — please try again shortly.");
  }
  button.disabled = false;
  button.textContent = originalText;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function showCheckoutBanner() {
  const params = new URLSearchParams(window.location.search);
  const status = params.get("checkout");
  if (!status) return;
  const banner = document.getElementById("checkout-banner");
  banner.hidden = false;
  if (status === "success") {
    banner.className = "banner success";
    // No automated fulfillment yet (library is still being QA'd) — don't
    // promise an email/download that nothing currently sends.
    banner.textContent = "Payment received — thanks! We'll be in touch shortly to arrange delivery.";
  } else if (status === "cancelled") {
    banner.className = "banner cancelled";
    banner.textContent = "Checkout cancelled — no payment was taken.";
  } else {
    banner.hidden = true;
  }
}

function wireLeadForm() {
  const form = document.getElementById("lead-form");
  const status = document.getElementById("lead-status");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    status.textContent = "";
    status.className = "form-status";

    const body = Object.fromEntries(new FormData(form).entries());
    try {
      const res = await fetch("/api/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        status.textContent = "Thanks — we'll be in touch within one business day.";
        status.className = "form-status ok";
        form.reset();
      } else {
        status.textContent = data.reason ?? "Something went wrong — please try again.";
        status.className = "form-status error";
      }
    } catch {
      status.textContent = "Something went wrong — please try again.";
      status.className = "form-status error";
    }
    submitButton.disabled = false;
  });
}

showCheckoutBanner();
wireLeadForm();
loadPackages();
