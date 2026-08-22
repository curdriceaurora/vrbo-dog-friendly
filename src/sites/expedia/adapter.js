// sites/expedia/adapter.js
// Expedia PDP adapter. Uses page-visible microdata/JSON-LD; no MAIN-world
// Apollo bridge is needed for the verified Expedia fixtures.

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    let registryModule = null;
    try {
      registryModule = require("../../shared/site-registry.js");
    } catch {}
    const api = factory(registryModule);
    module.exports = api;
    if (typeof globalThis !== "undefined") {
      globalThis.VdpExpediaAdapter = api;
      if (globalThis.VdpSiteRegistry && typeof globalThis.VdpSiteRegistry.registerSite === "function") {
        globalThis.VdpSiteRegistry.registerSite(api.expediaSite);
      }
    }
  /* node:coverage disable */
  } else {
    const api = factory(root.VdpSiteRegistry);
    root.VdpExpediaAdapter = api;
    if (root.VdpSiteRegistry && typeof root.VdpSiteRegistry.registerSite === "function") {
      root.VdpSiteRegistry.registerSite(api.expediaSite);
    }
  }
  /* node:coverage enable */
})(typeof globalThis !== "undefined" ? globalThis : this, function (registryModule) {
  "use strict";

  const LISTING_PATH = /^\/[^/]*\.h(\d+)\.Hotel-Information\/?$/i;

  function parseUrl(urlStr, baseUrl) {
    if (!registryModule || typeof registryModule.parseUrl !== "function") return null;
    return registryModule.parseUrl(urlStr, baseUrl, "https://www.expedia.com");
  }

  function expediaMatchesHostname(hostname) {
    if (!hostname || typeof hostname !== "string") return false;
    return /(^|\.)expedia\.com$/i.test(hostname);
  }

  function expediaIsListingUrl(urlStr, baseUrl) {
    const u = parseUrl(urlStr, baseUrl);
    if (!u || !expediaMatchesHostname(u.hostname)) return false;
    return LISTING_PATH.test(u.pathname);
  }

  function expediaIsSearchUrl() {
    return false;
  }

  function expediaGetPropertyId(urlStr, baseUrl) {
    const u = parseUrl(urlStr, baseUrl);
    if (!u || !expediaMatchesHostname(u.hostname)) return null;
    const m = LISTING_PATH.exec(u.pathname);
    return m ? m[1] : null;
  }

  function expediaGetCanonicalFetchUrl(urlStr, baseUrl) {
    const u = parseUrl(urlStr, baseUrl);
    if (!u || !expediaMatchesHostname(u.hostname)) return null;
    return `https://www.expedia.com${u.pathname}`;
  }

  function expediaDecorateFetchUrl(urlStr) {
    return urlStr;
  }

  function item(text) {
    const value = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
    if (!value) return null;
    return {
      header: "Pets",
      section: "Pet policy",
      text: value,
      explicitPetContext: true,
    };
  }

  function hasFaqType(node) {
    const type = node && node["@type"];
    return Array.isArray(type)
      ? type.some((t) => String(t).toLowerCase() === "faqpage")
      : String(type || "").toLowerCase() === "faqpage";
  }

  function collectFaqItems(scriptText, out) {
    let parsed;
    try {
      parsed = JSON.parse(scriptText);
    } catch {
      return;
    }
    const roots = Array.isArray(parsed) ? parsed : [parsed];
    for (const root of roots) {
      if (!hasFaqType(root)) continue;
      const entries = Array.isArray(root.mainEntity) ? root.mainEntity : [];
      for (const entry of entries) {
        const question = typeof entry?.name === "string" ? entry.name.trim() : "";
        if (!/^Is .* pet-friendly\??$/i.test(question)) continue;
        const answer = entry?.acceptedAnswer?.text;
        const policyItem = item(answer);
        if (policyItem) out.push(policyItem);
      }
    }
  }

  function expediaGetPdpStructuredPayload() {
    if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return null;
    const items = [];

    try {
      for (const node of document.querySelectorAll('meta[itemprop="petsAllowed"]')) {
        const content = typeof node.getAttribute === "function" ? node.getAttribute("content") : node.content;
        const policyItem = item(content);
        if (policyItem) items.push(policyItem);
      }
    } catch {}

    try {
      for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
        collectFaqItems(node.textContent || "", items);
      }
    } catch {}

    return items.length ? { items } : null;
  }

  const expediaSite = {
    id: "expedia",
    name: "Expedia",
    matchesHostname: expediaMatchesHostname,
    isListingUrl: expediaIsListingUrl,
    isSearchUrl: expediaIsSearchUrl,
    getPropertyId: expediaGetPropertyId,
    getCanonicalFetchUrl: expediaGetCanonicalFetchUrl,
    decorateFetchUrl: expediaDecorateFetchUrl,
    getCacheKey: (propertyId) => `vrbow_cache_expedia_${propertyId}`,
    getPdpStructuredPayload: expediaGetPdpStructuredPayload,
  };

  return { expediaSite, collectFaqItems };
});
