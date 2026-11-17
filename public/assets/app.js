// SiteGuard FORMS — page behaviour. No framework, no inline script (CSP).
// The cart lives in this browser only (localStorage). Prices shown here are
// for display; the server re-prices every line from the catalogue at checkout.
(function () {
  "use strict";
  var KEY = "sg-forms-cart-v1";
  var beta = document.body.getAttribute("data-beta") === "1";
  var preview = document.body.getAttribute("data-preview") === "1" || beta;
  // Site root, from this script's own address (works on the live domain and
  // on a review copy hosted under a sub-path).
  var script = document.currentScript || document.querySelector('script[src$="assets/app.js"]');
  var ROOT = script ? script.src.replace(/assets\/app\.js.*$/, "") : "/";

  //@@cart part 1
  // Menu
  var toggle = document.querySelector(".menu-toggle");
  if (toggle) toggle.addEventListener("click", function () {
    var nav = document.getElementById("site-nav");
    var open = nav.classList.toggle("open");
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  });

  //@@cart part 2
  // Enquiry form
  // Referral attribution: a partner's link carries ?ref=CODE. Keep it for this
  // visit only (sessionStorage, no cookie) and send it with an enquiry, so the
  // CRM can credit the partner. Invalid codes are ignored.
  var ref = "";
  try {
    var m = /[?&]ref=([A-Za-z0-9][A-Za-z0-9-]{1,23})(?:&|$)/.exec(window.location.search);
    if (m) sessionStorage.setItem("sg_ref", m[1]);
    ref = sessionStorage.getItem("sg_ref") || "";
  } catch (e) { ref = ""; }
  document.querySelectorAll("[data-ref-field]").forEach(function (i) { i.value = ref; });
  function val(f, n) { return f[n] && typeof f[n].value === "string" ? f[n].value : ""; }
  // FORMS queue S10: "Lost your documents?". Every answer shows the same
  // sentence, so the page reveals nothing about orders.
  document.querySelectorAll("[data-redelivery-form]").forEach(function (f) {
    var SAME = "If that matches an order, we've emailed the delivery address.";
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var status = f.querySelector("[data-status]");
      if (!f.order_number.value.trim() || !f.email.value.trim()) {
        status.className = "form-status err"; status.textContent = "Add your order number and email."; return;
      }
      status.className = "form-status"; status.textContent = "Sending…";
      fetch("/api/redelivery-request", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_number: f.order_number.value.trim(), email: f.email.value.trim(), website: f.website.value }) })
        .then(function () { f.reset(); status.className = "form-status ok"; status.textContent = SAME; })
        .catch(function () { status.className = "form-status ok"; status.textContent = SAME; });
    });
  });
  document.querySelectorAll("[data-lead-form]").forEach(function (f) {
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var status = f.querySelector("[data-status]");
      var interestForm = val(f, "enquiry_type") === "forms-interest";
      if (!f.name.value.trim() || !f.email.value.trim() || (!interestForm && !f.need.value.trim())) {
        status.className = "form-status err"; status.textContent = interestForm ? "Add your name and email." : "Add your name, email and what you need."; return;
      }
      var endpoint = f.getAttribute("data-endpoint") || "/api/lead";
      var data = { source: f.getAttribute("data-source"), name: f.name.value, email: f.email.value,
        company: f.company.value, phone: f.phone.value, need: f.need.value, website: f.website.value,
        enquiry_type: val(f, "enquiry_type") || "enquiry", ref: ref,
        partner_url: val(f, "partner_url"), partner_kind: val(f, "partner_kind") };
      // X2: campaign attribution (assets/attribution.js, loaded only while campaign counts are on).
      ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid"].forEach(function (k) {
        if (val(f, k)) data[k] = val(f, k);
      });
      if (interestForm) {
        // "Coming soon: register interest" (FORMS subscriptions and consultant
        // plans): an enquiry with the interest tag and the consent basis.
        data.interest = val(f, "interest");
        data.consent = f.consent && f.consent.checked ? "yes" : "";
        data.consent_wording = f.consent && f.consent.checked ? (f.consent.getAttribute("data-consent-wording") || "") : "";
        data.consent_source = window.location.href.split("?")[0];
      }
      status.className = "form-status"; status.textContent = "Sending…";
      fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
        .then(function (res) {
          if (res.ok) { f.reset(); status.className = "form-status ok"; status.textContent = interestForm ? "Thanks. Your interest is registered." : "Sent. We'll reply within one business day."; }
          else { status.className = "form-status err"; status.textContent = (res.body && res.body.reason) || "Your enquiry didn't send. Try again."; }
        })
        .catch(function () { status.className = "form-status err"; status.textContent = "Your enquiry didn't send. Check your connection and try again."; });
    });
  });

  renderCount();
  // FORMS switches (go-live 7 Nov 2026): subscription and consultant-plan
  // buttons stay "Coming soon: register interest" unless the storefront's
  // /api/switches (read from FORMS) says the switch is on. Any failure keeps
  // them off.
  var switchEls = document.querySelectorAll("[data-switch]");
  if (switchEls.length && window.fetch) {
    fetch("/api/switches", { headers: { Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (sw) {
        if (!sw) return;
        switchEls.forEach(function (el) {
          var on = sw[el.getAttribute("data-switch")] === true;
          el.hidden = (el.getAttribute("data-when") === "on") !== on;
        });
      })
      .catch(function () {});
  }
  // FORMS queue S11: while orders are closed (beta, a preview build, or FORMS'
  // sales switch off; any failure to ask counts as closed), each pack's
  // "Add to cart" becomes "Tell me when this pack opens": name, email and an
  // UNTICKED express opt-in box. Ticked, the lead is express consent with the
  // wording shown; unticked, it's an enquiry (a reply, nothing more). Once
  // FORMS opens orders the buttons come back on their own.
  var packBtns = document.querySelectorAll("[data-add-pack]");
  var PACK_OPT_IN = "Email me when this pack can be ordered, and with SiteGuard FORMS news. I can unsubscribe at any time.";
  function packInterest(btn) {
    if (btn.getAttribute("data-interest-swapped")) return;
    btn.setAttribute("data-interest-swapped", "1");
    btn.hidden = true;
    var open = document.createElement("button");
    open.type = "button"; open.className = "btn btn-small"; open.textContent = "Tell me when this pack opens";
    open.setAttribute("data-pack-interest", btn.getAttribute("data-add-pack"));
    var f = document.createElement("form");
    f.className = "form"; f.hidden = true; f.noValidate = true;
    f.setAttribute("data-pack-interest-form", btn.getAttribute("data-add-pack"));
    var uid = "pi-" + btn.getAttribute("data-add-pack").replace(/[^A-Za-z0-9]+/g, "-");
    f.innerHTML = '<label>Your name<input name="name" autocomplete="name" required maxlength="200"></label>' +
      '<label>Email<input type="email" name="email" autocomplete="email" required maxlength="200"></label>' +
      '<label class="check"><input type="checkbox" name="consent" id="' + uid + '"> <span></span></label>' +
      '<div class="hp" aria-hidden="true"><label>Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label></div>' +
      '<p class="form-status" data-status aria-live="polite"></p>' +
      '<div><button class="btn btn-small btn-hivis" type="submit">Notify me</button></div>';
    f.querySelector(".check span").textContent = PACK_OPT_IN;
    open.addEventListener("click", function () { f.hidden = false; open.hidden = true; f.name.focus(); });
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var status = f.querySelector("[data-status]");
      if (!f.name.value.trim() || !f.email.value.trim()) { status.className = "form-status err"; status.textContent = "Add your name and email."; return; }
      var ticked = f.consent.checked;
      status.className = "form-status"; status.textContent = "Sending…";
      fetch("/api/lead", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        source: "forms", name: f.name.value, email: f.email.value, website: f.website.value, ref: ref,
        enquiry_type: "pack-interest", pack: btn.getAttribute("data-add-pack"),
        consent: ticked ? "yes" : "", consent_wording: ticked ? PACK_OPT_IN : "",
        consent_source: window.location.href.split("?")[0] }) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
        .then(function (res) {
          if (res.ok) { f.reset(); status.className = "form-status ok"; status.textContent = ticked ? "Thanks. We'll email you when this pack can be ordered." : "Thanks. We've got your details."; }
          else { status.className = "form-status err"; status.textContent = (res.body && res.body.reason) || "That didn't send. Try again."; }
        })
        .catch(function () { status.className = "form-status err"; status.textContent = "That didn't send. Check your connection and try again."; });
    });
    btn.parentNode.insertBefore(f, btn.nextSibling);
    btn.parentNode.insertBefore(open, btn.nextSibling);
  }
  function ordersClosed() { packBtns.forEach(packInterest); }
  if (packBtns.length) {
    if (document.body.getAttribute("data-beta") === "1" || document.body.getAttribute("data-preview") === "1" || !window.fetch) ordersClosed();
    else fetch("/api/switches", { headers: { Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (sw) { if (!sw || sw.checkout_open !== true) ordersClosed(); })
      .catch(ordersClosed);
  }
  var pick = /[?&]interest=(subscriptions|consultant_plans)(?:&|$)/.exec(window.location.search);
  if (pick) document.querySelectorAll('select[name="interest"]').forEach(function (s) { s.value = pick[1]; });
  // Intro video (scripts/lib/video.mjs): the YouTube player loads only when
  // someone presses play. Without JavaScript the poster is a link to YouTube.
  document.querySelectorAll("[data-yt]").forEach(function (a) {
    a.addEventListener("click", function (e) {
      var id = a.getAttribute("data-yt");
      if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return;
      e.preventDefault();
      var f = document.createElement("iframe");
      f.src = "https://www.youtube-nocookie.com/embed/" + id + "?autoplay=1&rel=0&modestbranding=1";
      f.title = a.getAttribute("data-yt-title") || "Video";
      f.width = "1280"; f.height = "720";
      f.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture; fullscreen");
      f.setAttribute("allowfullscreen", "");
      f.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
      a.parentNode.replaceChild(f, a);
      f.focus();
    });
  });
  // Planning calendar (scripts/lib/planning.mjs): category and workplace
  // filters. Without JavaScript every entry shows.
  (function () {
    var today = new Date().toISOString().slice(0, 10);
    document.querySelectorAll("[data-plan-filter]").forEach(function (f) { f.addEventListener("submit", function (e) { e.preventDefault(); }); });
    var list = document.querySelector("[data-plan-list]");
    var cats = document.querySelectorAll("[data-plan-cat]");
    function run() {
      var on = {};
      cats.forEach(function (c) { on[c.value] = c.checked; });
      list.querySelectorAll(".plan-month").forEach(function (m) {
        var shown = 0;
        m.querySelectorAll(".plan-event").forEach(function (li) {
          var t = li.querySelector("time");
          var past = t && t.getAttribute("datetime") < today && !li.querySelector(".plan-range");
          var ok = !past && on[li.getAttribute("data-cat")] !== false;
          li.hidden = !ok; if (ok) shown++;
        });
        m.querySelector(".plan-empty").hidden = shown > 0;
      });
    }
    if (list) { cats.forEach(function (c) { c.addEventListener("change", run); }); run(); }
    var applies = document.querySelector("[data-plan-applies]");
    function runApplies() {
      var v = applies.value;
      document.querySelectorAll(".plan-group").forEach(function (g) {
        var shown = 0;
        g.querySelectorAll("tbody tr").forEach(function (tr) {
          var a = tr.getAttribute("data-applies");
          var ok = !v || a === v || a === "All workplaces";
          tr.hidden = !ok; if (ok) shown++;
        });
        g.hidden = shown === 0;
      });
    }
    if (applies) { applies.addEventListener("change", runApplies); runApplies(); }
  })();
  // Founding-offer panel (build-site.mjs foundingPanel): the static text says
  // "For the first 20 places." Once data/site-mode.json founding_places_api is
  // set (the founding API, rollout P2), the live count replaces it. Any failure
  // leaves the static text.
  document.querySelectorAll("[data-founding-places][data-api]").forEach(function (el) {
    var api = el.getAttribute("data-api"), total = Number(el.getAttribute("data-total")) || 20;
    if (!/^\/[A-Za-z0-9\/_-]*$/.test(api) || !window.fetch) return;
    fetch(api, { headers: { Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var n = j && Number(j.remaining);
        if (!j || !isFinite(n) || n < 0 || n > total) return;
        el.textContent = n === 0 ? "All " + total + " founding places are taken." : n + " of the first " + total + " places left.";
      })
      .catch(function () {});
  });
  // SiteGuard Education: "Copy link" buttons (scripts/lib/education.mjs).
  document.querySelectorAll("[data-copy]").forEach(function (b) {
    b.addEventListener("click", function () {
      var url = b.getAttribute("data-copy");
      var done = function () { var t = b.textContent; b.textContent = "Link copied"; setTimeout(function () { b.textContent = t; }, 2000); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, function () { window.prompt("Copy this link:", url); });
      else window.prompt("Copy this link:", url);
    });
  });
})();
