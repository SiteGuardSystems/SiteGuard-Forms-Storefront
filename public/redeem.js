// Redemption page: verify the magic-link token, show remaining balances per
// package, and submit one project's details against a chosen package.
const token = new URLSearchParams(window.location.search).get("token") ?? "";

const loading = document.getElementById("redeem-loading");
const errorBox = document.getElementById("redeem-error");
const form = document.getElementById("redeem-form");
const packageSelect = document.getElementById("redeem-package");
const balanceNote = document.getElementById("redeem-balance");

function showError(message) {
  loading.hidden = true;
  errorBox.hidden = false;
  errorBox.textContent = message;
}

async function init() {
  if (!token) {
    return showError("This link is missing its token — use the link from your purchase confirmation.");
  }
  try {
    const res = await fetch(`/api/redeem/status?token=${encodeURIComponent(token)}`);
    const data = await res.json();
    if (!data.ok) {
      return showError(
        data.reason === "token expired"
          ? "This link has expired — get in touch and we'll send you a fresh one."
          : "This link isn't valid — use the link from your purchase confirmation.",
      );
    }
    const entries = Object.entries(data.packages ?? {}).filter(([, remaining]) => remaining > 0);
    if (entries.length === 0) {
      return showError("No project credits remaining. Purchase another pack or subscription to add more.");
    }
    for (const [packageId, remaining] of entries) {
      const opt = document.createElement("option");
      opt.value = packageId;
      opt.textContent = `${packageId} (${remaining} remaining)`;
      packageSelect.appendChild(opt);
    }
    balanceNote.textContent = `Signed in as ${data.email ?? "your account"}.`;
    loading.hidden = true;
    form.hidden = false;
  } catch {
    showError("Couldn't check your link right now — please try again shortly.");
  }
}

form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const submitButton = form.querySelector('button[type="submit"]');
  const status = document.getElementById("redeem-status");
  submitButton.disabled = true;
  status.textContent = "";
  status.className = "form-status";

  const body = { token, ...Object.fromEntries(new FormData(form).entries()) };
  try {
    const res = await fetch("/api/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.ok) {
      status.textContent = `Submitted — ${data.remaining} project credit(s) remaining for this package. We'll be in touch to confirm delivery.`;
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

init();
