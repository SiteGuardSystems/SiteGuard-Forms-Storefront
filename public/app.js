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
    renderPackages(catalog.items ?? []);
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

function renderPackages(items) {
  grid.innerHTML = "";
  for (const item of items) {
    const card = document.createElement("article");
    card.className = `package-card tier-${item.tier}`;

    const bullets = (item.bullets ?? [])
      .map((b) => `<li>${escapeHtml(b)}</li>`)
      .join("");

    const isQuote = item.tier === "quote";
    const buyDisabled = !isQuote && !stripeConfigured;

    card.innerHTML = `
      <p class="package-name">${escapeHtml(item.name)}</p>
      <p class="package-tagline">${escapeHtml(item.tagline ?? "")}</p>
      <p class="package-price">${escapeHtml(item.priceLabel ?? "")}</p>
      <p class="package-price-suffix">${escapeHtml(item.priceSuffix ?? "")}</p>
      <p>${escapeHtml(item.description ?? "")}</p>
      <ul class="package-bullets">${bullets}</ul>
      <button class="btn ${isQuote ? "btn-ghost" : "btn-primary"} btn-block" data-id="${item.id}" data-quote="${isQuote}" ${buyDisabled ? "disabled" : ""}>
        ${isQuote ? escapeHtml(item.cta ?? "Request Quote") : buyDisabled ? "Coming Soon" : escapeHtml(item.cta ?? "Buy Now")}
      </button>
      ${buyDisabled ? `<p class="package-status">Checkout opens shortly — use the enquiry form below to be notified.</p>` : ""}
    `;

    const button = card.querySelector("button");
    button.addEventListener("click", () => handlePackageAction(item, isQuote, buyDisabled, button));
    grid.appendChild(card);
  }
}

async function handlePackageAction(item, isQuote, buyDisabled, button) {
  if (isQuote || buyDisabled) {
    document.getElementById("enquire").scrollIntoView({ behavior: "smooth" });
    const need = document.querySelector('textarea[name="need"]');
    if (need && !need.value) {
      need.value = `Interested in: ${item.name}`;
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
      body: JSON.stringify({ packageId: item.id }),
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

// TODO: wire this to the real QA-clean document count instead of a hardcoded
// figure. That count lives in the Artifact Factory's library_snapshot.json
// (OPS_DIR, internal-only) — this public storefront deliberately has no
// network path to that service, so either publish the single number via a
// small internal->public sync, or accept a manually-updated figure for now.
document.getElementById("stat-clean").textContent = "96+";
