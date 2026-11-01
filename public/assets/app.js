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

  function money(n) { return "$" + Number(n).toLocaleString("en-AU"); }
  function load() {
    try { var v = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(v) ? v : []; }
    catch (e) { return memoryCart; }
  }
  var memoryCart = [];
  function save(items) {
    memoryCart = items;
    try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) { /* private mode: keep in memory */ }
    renderCount();
  }
  function renderCount() {
    var n = load().length;
    document.querySelectorAll("[data-cart-count]").forEach(function (el) { el.textContent = "(" + n + ")"; });
  }
  function toast(msg) {
    var t = document.createElement("div");
    t.className = "toast"; t.setAttribute("role", "status"); t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3200);
  }
  function add(item) {
    var items = load();
    var key = item.packageId || item.documentCode;
    if (items.some(function (i) { return (i.packageId || i.documentCode) === key; })) {
      toast(item.name + " is already in your cart."); return;
    }
    if (items.length >= 50) { toast("Your cart can hold up to 50 items."); return; }
    items.push(item); save(items); toast("Added to cart: " + item.name);
  }

  // Menu
  var toggle = document.querySelector(".menu-toggle");
  if (toggle) toggle.addEventListener("click", function () {
    var nav = document.getElementById("site-nav");
    var open = nav.classList.toggle("open");
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  });

  // Disabled (preview) buttons and links
  document.addEventListener("click", function (e) {
    var dis = e.target.closest("[data-preview-disabled]");
    if (dis) { e.preventDefault(); toast(beta ? "SiteGuard FORMS is in beta: orders aren't open yet." : "Preview build: this package isn't on sale yet."); return; }
    var btn = e.target.closest("[data-add-pack]");
    if (btn) add({ packageId: btn.getAttribute("data-add-pack"), name: btn.getAttribute("data-name"), price: Number(btn.getAttribute("data-price")) });
    var doc = e.target.closest("[data-add-doc]");
    if (doc) add({ documentCode: doc.getAttribute("data-add-doc"), name: doc.getAttribute("data-name"), price: Number(doc.getAttribute("data-price")) });
  });

  // Long document lists load when opened
  document.querySelectorAll("details[data-lazy-docs]").forEach(function (d) {
    d.addEventListener("toggle", function () {
      if (!d.open || d.getAttribute("data-loaded")) return;
      d.setAttribute("data-loaded", "1");
      var ol = d.querySelector("ol");
      fetch(d.getAttribute("data-lazy-docs")).then(function (r) { return r.json(); }).then(function (rows) {
        ol.innerHTML = "";
        rows.forEach(function (row) {
          var li = document.createElement("li");
          var c = document.createElement("span"); c.className = "code"; c.textContent = row[0];
          var t = document.createElement("span"); t.textContent = row[1];
          li.appendChild(c); li.appendChild(t); ol.appendChild(li);
        });
      }).catch(function () { ol.innerHTML = "<li><span></span><span>The list couldn't load. Close and open it to try again.</span></li>"; d.removeAttribute("data-loaded"); });
    });
  });

  // Cart page
  var view = document.querySelector("[data-cart-view]");
  var form = document.querySelector("[data-checkout-form]");
  function renderCart() {
    if (!view) return;
    var items = load();
    if (!items.length) {
      view.innerHTML = '<p>Your cart is empty. <a href="' + ROOT + 'trade-packs/">Browse trade packs</a> or <a href="' + ROOT + 'documents/">single documents</a>.</p>';
      if (form) form.hidden = true;
      return;
    }
    var total = items.reduce(function (s, i) { return s + (i.price || 0); }, 0);
    var rows = items.map(function (i, idx) {
      var name = document.createElement("span"); name.textContent = i.name;
      return '<tr><td>' + name.innerHTML + '</td><td class="num">' + money(i.price) +
        '</td><td class="num"><button type="button" class="link-btn" data-remove="' + idx + '">Remove<span class="hp"> ' + name.innerHTML + '</span></button></td></tr>';
    }).join("");
    view.innerHTML = '<table class="cart-table"><thead><tr><th scope="col">Item</th><th scope="col" class="num">Price</th><th scope="col" class="num"><span class="hp">Remove</span></th></tr></thead><tbody>' +
      rows + '</tbody><tfoot><tr><th scope="row">Subtotal (ex GST)</th><td class="num"><strong>' + money(total) +
      '</strong></td><td></td></tr></tfoot></table><p class="small">GST is added at checkout. Prices are confirmed when you check out.</p>';
    if (form) form.hidden = false;
  }
  if (view) {
    view.addEventListener("click", function (e) {
      var b = e.target.closest("[data-remove]");
      if (!b) return;
      var items = load(); items.splice(Number(b.getAttribute("data-remove")), 1); save(items); renderCart();
    });
    renderCart();
  }
  if (form) form.addEventListener("submit", function (e) {
    e.preventDefault();
    var status = form.querySelector("[data-status]");
    if (preview) { status.className = "form-status err"; status.textContent = beta ? "SiteGuard FORMS is in beta: orders aren't open yet." : "Preview build: checkout is switched off."; return; }
    if (!form.accept.checked) { status.className = "form-status err"; status.textContent = "Tick the box to accept the Terms of Sale and the Document Use Disclaimer."; form.accept.focus(); return; }
    var cart = load().map(function (i) { return i.packageId ? { packageId: i.packageId } : { documentCode: i.documentCode }; });
    status.className = "form-status"; status.textContent = "Opening secure checkout…";
    form.querySelector("button[type=submit]").disabled = true;
    fetch("/api/checkout", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cart: cart, acceptedTerms: true, termsVersion: form.termsVersion.value, siteName: form.siteName ? form.siteName.value : "" }),
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        if (res.ok && res.body.url) { window.location.href = res.body.url; return; }
        status.className = "form-status err"; status.textContent = (res.body && res.body.reason) || "Checkout couldn't start. Try again in a moment.";
        form.querySelector("button[type=submit]").disabled = false;
      })
      .catch(function () {
        status.className = "form-status err"; status.textContent = "Checkout couldn't start. Check your connection and try again.";
        form.querySelector("button[type=submit]").disabled = false;
      });
  });
  if (location.pathname === "/order/success/") save([]);

  // Single documents finder
  var table = document.querySelector("[data-doc-table]");
  if (table) {
    var filters = document.querySelector("[data-doc-filters]");
    var count = document.querySelector("[data-doc-count]");
    var tbody = table.querySelector("tbody");
    var all = [], price = Number(table.getAttribute("data-price")) || 0;
    var esc = function (s) { var d = document.createElement("span"); d.textContent = s; return d.innerHTML; };
    var draw = function () {
      var q = (filters.q.value || "").trim().toLowerCase();
      var fam = filters.family.value, tr = filters.trade.value;
      var hits = all.filter(function (d) {
        return (!fam || d.family === fam) && (!tr || d.trade === tr) &&
          (!q || d.code.toLowerCase().indexOf(q) >= 0 || d.title.toLowerCase().indexOf(q) >= 0);
      });
      count.textContent = hits.length + " of " + all.length + " documents";
      tbody.innerHTML = hits.slice(0, 100).map(function (d) {
        var dis = preview ? ' aria-disabled="true" data-preview-disabled="1"' : "";
        return '<tr><td class="code">' + esc(d.code) + '</td><td>' + esc(d.title) + '</td><td>' + esc(d.family) +
          '</td><td><button type="button" class="btn btn-small" data-add-doc="' + esc(d.code) + '" data-name="' + esc(d.code + " " + d.title) +
          '" data-price="' + price + '"' + dis + '>Add ' + money(price) + '<span class="hp"> ' + esc(d.title) + '</span></button></td></tr>';
      }).join("");
      if (hits.length > 100) count.textContent += " (showing the first 100; search or filter to narrow the list)";
    };
    fetch(ROOT + "assets/documents.json").then(function (r) { return r.json(); }).then(function (j) {
      all = j.documents || []; draw();
    }).catch(function () { count.textContent = "The document list couldn't load. Refresh the page to try again."; });
    filters.addEventListener("input", draw);
    filters.addEventListener("submit", function (e) { e.preventDefault(); });
  }

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
  document.querySelectorAll("[data-lead-form]").forEach(function (f) {
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var status = f.querySelector("[data-status]");
      if (!f.name.value.trim() || !f.email.value.trim() || !f.need.value.trim()) {
        status.className = "form-status err"; status.textContent = "Add your name, email and what you need."; return;
      }
      var endpoint = f.getAttribute("data-endpoint") || "/api/lead";
      var data = { source: f.getAttribute("data-source"), name: f.name.value, email: f.email.value,
        company: f.company.value, phone: f.phone.value, need: f.need.value, website: f.website.value,
        enquiry_type: val(f, "enquiry_type") || "enquiry", ref: ref,
        partner_url: val(f, "partner_url"), partner_kind: val(f, "partner_kind") };
      status.className = "form-status"; status.textContent = "Sending…";
      fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
        .then(function (res) {
          if (res.ok) { f.reset(); status.className = "form-status ok"; status.textContent = "Sent. We'll reply within one business day."; }
          else { status.className = "form-status err"; status.textContent = (res.body && res.body.reason) || "Your enquiry didn't send. Try again."; }
        })
        .catch(function () { status.className = "form-status err"; status.textContent = "Your enquiry didn't send. Check your connection and try again."; });
    });
  });

  renderCount();
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
