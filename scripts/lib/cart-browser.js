// SiteGuard cart: the browser side, shared by both SiteGuard websites (the same
// file lives in SiteGuard-Forms-Storefront and siteguard-website; keep them
// identical). Not a script on its own: scripts/lib/cart.mjs puts the parts
// below into the storefront's app.js (spliceCart) and into the Systems site's
// /assets/cart.js (systemsCartScript). The parts expect KEY, beta, preview and
// ROOT to be defined around them. No inline script (CSP). The cart lives in
// this browser only (localStorage); prices shown are for display, and the
// checkout engine re-prices every line from the catalogue.
//@@part 1
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

//@@part 2
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

//@@end
