// X2 (S6, 10 Nov 2026): campaign attribution, the storefront half of a pair with the
// website (W10): same file, same field names, same storage key. The server adds this
// script to the pages only while CAMPAIGN_COUNTS=on, so with counts off nothing here runs.
// It keeps utm_* and gclid from the landing URL for this visit only (sessionStorage
// "sg_attribution"; no cookie, no localStorage; the first landing in the visit wins),
// adds them to every enquiry form as hidden fields, and offers them to checkout through
// window.sgAttribution(). Values are never shown or sent anywhere else.
(function (w, d) {
  "use strict";
  var KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid"];
  var STORE = "sg_attribution";
  var MAX = 100;
  function clean(o) {
    var out = {};
    if (!o || typeof o !== "object") return out;
    KEYS.forEach(function (k) {
      var v = o[k];
      if (typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, MAX);
    });
    return out;
  }
  var kept = {};
  try {
    kept = clean(JSON.parse(w.sessionStorage.getItem(STORE) || "null"));
    if (!Object.keys(kept).length) {
      var q = new URLSearchParams(w.location.search);
      var landed = {};
      KEYS.forEach(function (k) { var v = q.get(k); if (v) landed[k] = v; });
      kept = clean(landed);
      if (Object.keys(kept).length) w.sessionStorage.setItem(STORE, JSON.stringify(kept));
    }
  } catch (e) { kept = {}; }
  w.sgAttribution = function () { return clean(kept); };
  function addFields() {
    var a = w.sgAttribution();
    Array.prototype.forEach.call(d.querySelectorAll("[data-lead-form]"), function (f) {
      Object.keys(a).forEach(function (k) {
        var i = f.querySelector('input[type="hidden"][name="' + k + '"]');
        if (!i) { i = d.createElement("input"); i.type = "hidden"; i.name = k; f.appendChild(i); }
        i.value = a[k];
      });
    });
  }
  if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", addFields);
  else addFields();
})(window, document);
