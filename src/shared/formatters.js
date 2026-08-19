// Shared, pure formatting helpers with no DOM/chrome.* dependencies.
//
// Loaded before content.js and popup.js in their respective contexts, where
// it assigns itself to globalThis; both scripts then call it as
// `VdpFormatters.*`. escapeHtml was previously duplicated verbatim in both
// content.js and popup.js; formatMoney/CURRENCY_SYMBOLS here is popup.js's
// formatter for already-numeric canonical policy values — it is NOT the
// same thing as extract.js's separate formatMoney(cur, amt), which formats
// raw regex-captured strings and has its own currency table. The two were
// deliberately kept separate rather than merged (see the plan's Global
// Constraints for why).

(function (root, factory) {
  const api = factory();
  root.VdpFormatters = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  const CURRENCY_SYMBOLS = {
    USD: "$",
    EUR: "€",
    GBP: "£",
    JPY: "¥",
    AUD: "A$",
    CAD: "CA$",
    NZD: "NZ$",
  };

  function formatMoney(amount, currency = "USD") {
    if (typeof amount !== "number") return "";
    const code = String(currency || "USD").trim().toUpperCase();
    const sym = CURRENCY_SYMBOLS[code] || `${code} `;
    return `${sym}${amount}`;
  }

  return { escapeHtml, formatMoney, CURRENCY_SYMBOLS };
});
