// site-registry.js
// Centralized site detection, URL routing, and property-ID extraction.

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    let ext = null;
    try {
      ext = require("./extract.js");
    } catch {}
    const api = factory(ext);
    api.__factory = factory;
    module.exports = api;
    if (typeof globalThis !== "undefined") globalThis.VdpSiteRegistry = api;
  } else {
    root.VdpSiteRegistry = factory(root.VDPExtract || root.VdpExtract);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (extractModule) {
  "use strict";

  const cachedExtractor =
    extractModule && typeof extractModule.extractPropertyId === "function" ? extractModule : null;

  function parseUrl(urlStr, baseUrl) {
    if (!urlStr || typeof urlStr !== "string") return null;
    try {
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(urlStr)) {
        return new URL(urlStr);
      }
      if (urlStr.startsWith("/")) {
        return new URL(urlStr, baseUrl || "https://www.vrbo.com");
      }
      if (baseUrl) {
        return new URL(urlStr, baseUrl);
      }
      return null;
    } catch {
      return null;
    }
  }

  function getExtractor() {
    if (typeof globalThis !== "undefined") {
      if (globalThis.VDPExtract && typeof globalThis.VDPExtract.extractPropertyId === "function") {
        return globalThis.VDPExtract;
      }
      if (globalThis.VdpExtract && typeof globalThis.VdpExtract.extractPropertyId === "function") {
        return globalThis.VdpExtract;
      }
    }
    return cachedExtractor;
  }

  function vrboMatchesHostname(hostname) {
    if (!hostname || typeof hostname !== "string") return false;
    return /^(www\.)?vrbo\.com$/i.test(hostname);
  }

  function vrboIsListingUrl(urlStr, baseUrl) {
    const u = parseUrl(urlStr, baseUrl);
    if (!u || !vrboMatchesHostname(u.hostname)) return false;
    const path = u.pathname;
    if (/^\/\d+[a-z0-9]*\/?$/i.test(path)) return true;
    if (/^\/pdp(\/lo)?\/\d+[a-z0-9]*\/?$/i.test(path)) return true;
    if (/^\/vacation-rentals?(\/p)?\/?p?\d+[a-z0-9]*\/?$/i.test(path)) return true;
    return false;
  }

  function vrboIsSearchUrl(urlStr, baseUrl) {
    const u = parseUrl(urlStr, baseUrl);
    if (!u || !vrboMatchesHostname(u.hostname)) return false;
    return /(?:^|\/)(?:search|hotel-search|vacation-rentals\/search)(?:\/|\?|#|$)/i.test(u.pathname);
  }

  function vrboGetPropertyId(urlStr, baseUrl) {
    if (!urlStr || typeof urlStr !== "string") return null;
    const u = parseUrl(urlStr, baseUrl);
    if (!u || !vrboMatchesHostname(u.hostname)) return null;

    const ext = getExtractor();
    if (ext && typeof ext.extractPropertyId === "function") {
      return ext.extractPropertyId(urlStr, baseUrl);
    }
    const m = /(?:\/pdp(?:\/lo)?\/|\/vacation-rentals?(?:\/p)?\/p?|\/)(p?\d+[a-z0-9]*)(?:\/|\?|$)/i.exec(u.pathname);
    if (!m) return null;
    let id = m[1];
    if (/^p\d+/i.test(id)) id = id.slice(1);
    return id || null;
  }

  function vrboGetCanonicalFetchUrl(urlStr, baseUrl) {
    if (!urlStr || typeof urlStr !== "string") return null;
    const u = parseUrl(urlStr, baseUrl);
    if (!u || !vrboMatchesHostname(u.hostname)) return null;
    return `https://www.vrbo.com${u.pathname}`;
  }

  function vrboDecorateFetchUrl(urlStr, baseUrl) {
    if (!urlStr || typeof urlStr !== "string") return urlStr;
    const u = parseUrl(urlStr, baseUrl);
    if (!u || !vrboMatchesHostname(u.hostname)) return urlStr;
    u.searchParams.set("locale", "en_US");
    u.searchParams.set("siteid", "1");
    return u.toString();
  }

  // Vrbo site definition
  const vrboSite = {
    id: "vrbo",
    matchesHostname: vrboMatchesHostname,
    isListingUrl: vrboIsListingUrl,
    isSearchUrl: vrboIsSearchUrl,
    getPropertyId: vrboGetPropertyId,
    getCanonicalFetchUrl: vrboGetCanonicalFetchUrl,
    decorateFetchUrl: vrboDecorateFetchUrl,
  };

  const SITES = [vrboSite];

  function getSiteForHostname(hostname) {
    if (!hostname || typeof hostname !== "string") return null;
    return SITES.find((s) => s.matchesHostname(hostname)) || null;
  }

  function getSiteForUrl(urlStr, baseUrl) {
    const u = parseUrl(urlStr, baseUrl);
    if (!u) return null;
    return getSiteForHostname(u.hostname);
  }

  function getCanonicalFetchUrl(urlStr, baseUrl) {
    const u = parseUrl(urlStr, baseUrl);
    if (!u) return null;
    const site = getSiteForHostname(u.hostname);
    if (site && typeof site.getCanonicalFetchUrl === "function") {
      return site.getCanonicalFetchUrl(urlStr, baseUrl);
    }
    return `https://${u.hostname}${u.pathname}`;
  }

  function decorateFetchUrl(urlStr, baseUrl) {
    const u = parseUrl(urlStr, baseUrl);
    if (!u) return urlStr;
    const site = getSiteForHostname(u.hostname);
    if (site && typeof site.decorateFetchUrl === "function") {
      return site.decorateFetchUrl(urlStr, baseUrl);
    }
    return urlStr;
  }

  return {
    getSiteForUrl,
    getSiteForHostname,
    getCanonicalFetchUrl,
    decorateFetchUrl,
  };
});
