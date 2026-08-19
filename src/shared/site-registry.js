// site-registry.js
// Centralized site detection, URL routing, and property-ID extraction.

(function (root, factory) {
  const api = factory();
  root.VdpSiteRegistry = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function parseUrl(urlStr) {
    if (!urlStr || typeof urlStr !== "string") return null;
    try {
      return new URL(urlStr);
    } catch {
      return null;
    }
  }

  // Vrbo site definition
  const vrboSite = {
    id: "vrbo",
    matchesHostname(hostname) {
      if (!hostname || typeof hostname !== "string") return false;
      return /^(www\.)?vrbo\.com$/i.test(hostname);
    },
    isListingUrl(urlStr) {
      const u = parseUrl(urlStr);
      if (!u || !this.matchesHostname(u.hostname)) return false;
      const path = u.pathname;
      if (/^\/\d+[a-z0-9]*\/?$/i.test(path)) return true;
      if (/^\/pdp(\/lo)?\/\d+[a-z0-9]*\/?$/i.test(path)) return true;
      if (/^\/vacation-rentals?(\/p)?\/?p?\d+[a-z0-9]*\/?$/i.test(path)) return true;
      return false;
    },
    isSearchUrl(urlStr) {
      const u = parseUrl(urlStr);
      if (!u || !this.matchesHostname(u.hostname)) return false;
      return /^\/(?:search|hotel-search|vacation-rentals\/search)/i.test(u.pathname);
    },
    getPropertyId(urlStr) {
      if (!urlStr || typeof urlStr !== "string") return null;
      if (typeof globalThis !== "undefined" && globalThis.VdpSearchFetcher?.extractPropertyIdFromUrl) {
        return globalThis.VdpSearchFetcher.extractPropertyIdFromUrl(urlStr);
      }
      if (typeof globalThis !== "undefined" && globalThis.VDPExtract?.extractPropertyId) {
        return globalThis.VDPExtract.extractPropertyId(urlStr);
      }
      const u = parseUrl(urlStr);
      if (!u || !this.matchesHostname(u.hostname)) return null;
      const m = /(?:\/pdp(?:\/lo)?\/|\/vacation-rentals?(?:\/p)?\/p?|\/)(p?\d+[a-z0-9]*)(?:\/|\?|$)/i.exec(u.pathname);
      if (!m) return null;
      let id = m[1];
      if (/^p\d+/i.test(id)) id = id.slice(1);
      return id;
    },
  };

  const SITES = [vrboSite];

  function getSiteForHostname(hostname) {
    if (!hostname || typeof hostname !== "string") return null;
    return SITES.find((s) => s.matchesHostname(hostname)) || null;
  }

  function getSiteForUrl(urlStr) {
    const u = parseUrl(urlStr);
    if (!u) return null;
    return getSiteForHostname(u.hostname);
  }

  return {
    getSiteForUrl,
    getSiteForHostname,
  };
});
