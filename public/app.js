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
      category.layout === "chips"
        ? renderChipGrid(items)
        : category.layout === "accordion"
          ? renderAccordionGrid(items)
          : renderCardGrid(items),
    );
    grid.appendChild(section);
  }
}

/** Resolve what a *specific option* (or the plain item, when it has none)
 *  actually is right now: its purchasability, its price fields, and its
 *  button label. Every option inherits anything it doesn't override from
 *  the item — a rung that doesn't set its own `tier` is self-serve like
 *  its siblings; one that sets `tier: "quote"` isn't, even though other
 *  rungs on the same item are. This is what makes switching tabs on, say,
 *  a Builder Pack (Domestic/Light Commercial self-serve, Heavy Commercial/
 *  ISO-OFSC quote-only) change the whole card, not just the price line. */
function resolveVariant(item, optionKey) {
  const variant = optionKey ? { ...item, ...item.purchaseOptions[optionKey] } : item;
  const state = resolvedState(variant);
  const label =
    state === "quote" ? (variant.cta ?? "Request Quote") : state === "coming-soon" ? "Coming Soon" : (variant.cta ?? "Buy Now");
  return { variant, state, label };
}

/** A native <details> block listing exactly what's in a package — full
 *  transparency on what a buyer actually receives, not just marketing
 *  bullets. Empty string when a variant carries no documents list, so
 *  callers can splice it in unconditionally. */
function renderDocList(documents) {
  if (!documents || !documents.length) return "";
  const rows = documents
    .map((d) => `<li><span class="doc-code">${escapeHtml(d.code ?? "")}</span>${escapeHtml(d.title ?? "")}</li>`)
    .join("");
  return `
    <details class="doc-list" data-role="doclist">
      <summary>View all ${documents.length} included documents</summary>
      <ul>${rows}</ul>
    </details>
  `;
}

function renderCardGrid(items) {
  const container = document.createElement("div");
  container.className = "package-grid";
  for (const item of items) {
    const card = document.createElement("article");

    const hasOptions = Boolean(item.purchaseOptions);
    // Preserves whatever order the catalog JSON defines the options in
    // (object key order, e.g. domestic -> light-commercial -> heavy-commercial
    // -> iso-ofsc) rather than a fixed list that only fit the one purpose it
    // was written for.
    const optionKeys = hasOptions ? Object.keys(item.purchaseOptions) : [];
    let selectedOption = hasOptions
      ? item.defaultOption && optionKeys.includes(item.defaultOption)
        ? item.defaultOption
        : optionKeys[0]
      : null;

    const bullets = (item.bullets ?? []).map((b) => `<li>${escapeHtml(b)}</li>`).join("");
    const { variant: initial, state: initialState, label: initialLabel } = resolveVariant(item, selectedOption);

    card.className = `package-card tier-${initialState}`;
    card.innerHTML = `
      <p class="package-name">${escapeHtml(item.name)}</p>
      <p class="package-tagline" data-role="tagline">${escapeHtml(initial.tagline ?? "")}</p>
      ${
        hasOptions
          ? `<div class="option-tabs" role="tablist">${optionKeys
              .map(
                (key) =>
                  `<button type="button" class="option-tab${key === selectedOption ? " active" : ""}" data-option="${key}">${escapeHtml(item.purchaseOptions[key].label ?? item.purchaseOptions[key].name ?? key)}</button>`,
              )
              .join("")}</div>`
          : ""
      }
      <p class="package-price" data-role="price">${escapeHtml(initial.priceLabel ?? "")}</p>
      <p class="package-price-suffix" data-role="price-suffix">${escapeHtml(initial.priceSuffix ?? "")}</p>
      <p data-role="option-desc">${escapeHtml(initial.description ?? "")}</p>
      <ul class="package-bullets" data-role="bullets">${bullets}</ul>
      ${renderDocList(initial.documents)}
      <button class="btn btn-block" data-role="buy">${escapeHtml(initialLabel)}</button>
      <p class="package-status" data-role="status"></p>
    `;
    updateStatusLine(card, initialState);

    const button = card.querySelector('[data-role="buy"]');
    button.className = `btn ${initialState === "self-serve" ? "btn-primary" : "btn-ghost"} btn-block`;

    if (hasOptions) {
      const tabs = [...card.querySelectorAll(".option-tab")];
      tabs.forEach((tab) =>
        tab.addEventListener("click", () => {
          selectedOption = tab.dataset.option;
          tabs.forEach((t) => t.classList.toggle("active", t === tab));
          const { variant, state, label } = resolveVariant(item, selectedOption);
          card.className = `package-card tier-${state}`;
          card.querySelector('[data-role="tagline"]').textContent = variant.tagline ?? "";
          card.querySelector('[data-role="price"]').textContent = variant.priceLabel ?? "";
          card.querySelector('[data-role="price-suffix"]').textContent = variant.priceSuffix ?? "";
          card.querySelector('[data-role="option-desc"]').textContent = variant.description ?? "";
          const bulletsEl = card.querySelector('[data-role="bullets"]');
          bulletsEl.innerHTML = (variant.bullets ?? item.bullets ?? []).map((b) => `<li>${escapeHtml(b)}</li>`).join("");
          card.querySelector('[data-role="doclist"]')?.remove();
          const newDocList = renderDocList(variant.documents);
          if (newDocList) bulletsEl.insertAdjacentHTML("afterend", newDocList);
          button.textContent = label;
          button.className = `btn ${state === "self-serve" ? "btn-primary" : "btn-ghost"} btn-block`;
          updateStatusLine(card, state);
        }),
      );
    }

    button.addEventListener("click", () => {
      // Re-resolve at click time, not render time — selectedOption may have
      // changed since the card was built.
      const { state } = resolveVariant(item, selectedOption);
      handlePackageAction(item, state, button, hasOptions ? selectedOption : null);
    });
    container.appendChild(card);
  }
  return container;
}

/** Same purchasability/tab-switching behaviour as renderCardGrid, but each
 *  item starts collapsed to a one-line header (name + representative price)
 *  and expands on click. Built for Subcontractor Packs specifically — 24
 *  full cards stacked vertically buried the page; this keeps the same
 *  content but only renders it open for the one trade a visitor actually
 *  wants. */
function renderAccordionGrid(items) {
  const container = document.createElement("div");
  container.className = "trade-accordion";
  for (const item of items) {
    const itemEl = document.createElement("div");
    itemEl.className = "accordion-item";

    const hasOptions = Boolean(item.purchaseOptions);
    const optionKeys = hasOptions ? Object.keys(item.purchaseOptions) : [];
    let selectedOption = hasOptions
      ? item.defaultOption && optionKeys.includes(item.defaultOption)
        ? item.defaultOption
        : optionKeys[0]
      : null;

    const { variant: initial, state: initialState, label: initialLabel } = resolveVariant(item, selectedOption);

    const header = document.createElement("button");
    header.type = "button";
    header.className = "accordion-header";
    header.setAttribute("aria-expanded", "false");
    header.innerHTML = `
      <span class="accordion-name">${escapeHtml(item.name)}</span>
      <span class="accordion-summary">${escapeHtml(initial.priceLabel ?? "")}</span>
      <svg class="accordion-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
    `;

    const body = document.createElement("div");
    body.className = "accordion-body";
    body.hidden = true;

    const bullets = (item.bullets ?? []).map((b) => `<li>${escapeHtml(b)}</li>`).join("");
    body.innerHTML = `
      <p class="package-tagline" data-role="tagline">${escapeHtml(initial.tagline ?? "")}</p>
      ${
        hasOptions
          ? `<div class="option-tabs" role="tablist">${optionKeys
              .map(
                (key) =>
                  `<button type="button" class="option-tab${key === selectedOption ? " active" : ""}" data-option="${key}">${escapeHtml(item.purchaseOptions[key].label ?? item.purchaseOptions[key].name ?? key)}</button>`,
              )
              .join("")}</div>`
          : ""
      }
      <p class="package-price" data-role="price">${escapeHtml(initial.priceLabel ?? "")}</p>
      <p class="package-price-suffix" data-role="price-suffix">${escapeHtml(initial.priceSuffix ?? "")}</p>
      <p data-role="option-desc">${escapeHtml(initial.description ?? "")}</p>
      <ul class="package-bullets" data-role="bullets">${bullets}</ul>
      ${renderDocList(initial.documents)}
      <button class="btn btn-block" data-role="buy">${escapeHtml(initialLabel)}</button>
      <p class="package-status" data-role="status"></p>
    `;
    updateStatusLine(body, initialState);

    const button = body.querySelector('[data-role="buy"]');
    button.className = `btn ${initialState === "self-serve" ? "btn-primary" : "btn-ghost"} btn-block`;

    if (hasOptions) {
      const tabs = [...body.querySelectorAll(".option-tab")];
      tabs.forEach((tab) =>
        tab.addEventListener("click", (e) => {
          e.stopPropagation();
          selectedOption = tab.dataset.option;
          tabs.forEach((t) => t.classList.toggle("active", t === tab));
          const { variant, state, label } = resolveVariant(item, selectedOption);
          body.querySelector('[data-role="tagline"]').textContent = variant.tagline ?? "";
          body.querySelector('[data-role="price"]').textContent = variant.priceLabel ?? "";
          body.querySelector('[data-role="price-suffix"]').textContent = variant.priceSuffix ?? "";
          body.querySelector('[data-role="option-desc"]').textContent = variant.description ?? "";
          const bulletsEl = body.querySelector('[data-role="bullets"]');
          bulletsEl.innerHTML = (variant.bullets ?? item.bullets ?? []).map((b) => `<li>${escapeHtml(b)}</li>`).join("");
          body.querySelector('[data-role="doclist"]')?.remove();
          const newDocList = renderDocList(variant.documents);
          if (newDocList) bulletsEl.insertAdjacentHTML("afterend", newDocList);
          button.textContent = label;
          button.className = `btn ${state === "self-serve" ? "btn-primary" : "btn-ghost"} btn-block`;
          updateStatusLine(body, state);
        }),
      );
    }

    button.addEventListener("click", () => {
      const { state } = resolveVariant(item, selectedOption);
      handlePackageAction(item, state, button, hasOptions ? selectedOption : null);
    });

    header.addEventListener("click", () => {
      const willOpen = body.hidden;
      body.hidden = !willOpen;
      itemEl.classList.toggle("open", willOpen);
      header.setAttribute("aria-expanded", String(willOpen));
    });

    itemEl.appendChild(header);
    itemEl.appendChild(body);
    container.appendChild(itemEl);
  }
  return container;
}

/** Shows/hides the "not available yet" status line under a card, without
 *  rebuilding the whole card — called both on initial render and whenever
 *  a rung-picker tab switches to/from a coming-soon option. */
function updateStatusLine(card, state) {
  const status = card.querySelector('[data-role="status"]');
  if (state === "coming-soon") {
    status.hidden = false;
    status.textContent = "Not available for purchase yet — use the enquiry form below to be notified.";
  } else {
    status.hidden = true;
    status.textContent = "";
  }
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
    const variantName = option ? (item.purchaseOptions?.[option]?.name ?? option) : null;
    const label = item.trade ? `SWMS — ${item.trade}` : variantName ?? item.name;
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
