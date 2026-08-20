// site-registry.js
// Centralized site detection, URL routing, adapter capabilities, and property-ID extraction.

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

  const DEFAULT_SEARCH_CARD_SELECTOR =
    '[data-stid="lodging-card-responsive"], [data-stid="property-card"], [data-testid="property-card"], article[data-stid*="card"], div[data-stid*="property-card"]';

  const DEFAULT_CARD_CONTENT_SELECTORS = [
    ".uitk-card-content",
    '[data-stid*="content"]',
    '[data-stid*="price"]',
  ];

  // ---------- PDP (listing detail page) DOM layout ----------
  // Search-page selectors above route through the registry already; these
  // cover the *listing* page's own DOM shape instead — the anchor the panel
  // positions itself beside (#44), and the section categorization the DOM
  // text-scan fallback uses to label where a pet-policy snippet came from
  // (findSectionHeadingForElement in content.js). Both were Vrbo-specific
  // literals inline in content.js until this pass; a second site supplies
  // its own values here instead of content.js falling back to Vrbo's DOM
  // forever. Defaults below are exactly Vrbo's prior hardcoded behavior,
  // so this refactor changes nothing for Vrbo itself.
  const DEFAULT_PDP_CONTENT_COLUMN_SELECTOR = '[data-stid="lodging-infosite-template-api-renderer"]';

  // Fast path: does `element` sit inside a container whose selector alone
  // identifies the section, with no heading text involved?
  // `shortLabel` is what the panel's compact per-row jump link renders
  // (content.js's shortSourceLabel) — kept alongside the full `label` here,
  // one definition per section, instead of a second lookup table content.js
  // would otherwise have to keep in sync with these strings by hand.
  const DEFAULT_PDP_SECTION_CLOSE_MATCHERS = [
    { selector: '#reviews, [id*="reviews" i], [data-stid*="reviews" i], [data-stid*="ratings-and-reviews"], [class*="reviews-" i], [class*="reviews " i], [class$="reviews" i], [data-section-type*="review" i]', label: "Guest reviews", shortLabel: "Reviews" },
    { selector: '[data-stid*="house-rules" i], [class*="house-rules" i], [id*="house-rules" i], [data-stid*="policies" i], [id*="policies" i]', label: "House Rules / Policies", shortLabel: "House Rules" },
    { selector: '[data-stid*="about" i], [class*="about" i], [id*="about" i]', label: "About this property", shortLabel: "About" },
    { selector: '[data-stid*="amenit" i], [class*="amenit" i], [id*="amenit" i]', label: "Property amenities", shortLabel: "Amenities" },
    { selector: '[data-stid*="host" i], [class*="host" i], [id*="host" i]', label: "About the host", shortLabel: "Host" },
    { selector: '[data-stid*="faq" i], [class*="faq" i], [id*="faq" i], [data-stid*="qna" i]', label: "Questions & answers", shortLabel: "Q&A" },
  ];

  // Fallback path: walk ancestors looking for a heading element's text.
  const DEFAULT_PDP_SECTION_HEADING_CATEGORIES = [
    { pattern: /review|rating/i, label: "Guest reviews", shortLabel: "Reviews" },
    { pattern: /house rules|polic/i, label: "House Rules / Policies", shortLabel: "House Rules" },
    { pattern: /about this property|about this space|description/i, label: "About this property", shortLabel: "About" },
    { pattern: /amenit/i, label: "Property amenities", shortLabel: "Amenities" },
    { pattern: /host/i, label: "About the host", shortLabel: "Host" },
  ];

  // Same ancestor walk, but categorizing an aria-label/data-stid/id instead
  // of heading text — deliberately narrower patterns (e.g. bare "about"
  // rather than "about this property|about this space|description") since
  // these attribute values tend to be single tokens, not full sentences.
  const DEFAULT_PDP_SECTION_LABEL_CATEGORIES = [
    { pattern: /review/i, label: "Guest reviews", shortLabel: "Reviews" },
    { pattern: /house-rules|policies/i, label: "House Rules / Policies", shortLabel: "House Rules" },
    { pattern: /about/i, label: "About this property", shortLabel: "About" },
    { pattern: /amenit/i, label: "Property amenities", shortLabel: "Amenities" },
    { pattern: /host/i, label: "About the host", shortLabel: "Host" },
  ];

  const DEFAULT_PDP_FALLBACK_SECTION_LABEL = "Listing details";
  const DEFAULT_PDP_FALLBACK_SECTION_SHORT_LABEL = "Listing";

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
      if (globalThis.VDPExtract && typeof globalThis.VDPExtract === "object") {
        return globalThis.VDPExtract;
      }
      if (globalThis.VdpExtract && typeof globalThis.VdpExtract === "object") {
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

  function vrboParseListingData(html, urlStr, propertyId, canonicalId) {
    if (
      typeof globalThis !== "undefined" &&
      globalThis.VdpSearchFetcher &&
      typeof globalThis.VdpSearchFetcher.parseListingHtml === "function"
    ) {
      return globalThis.VdpSearchFetcher.parseListingHtml(html, propertyId, canonicalId);
    }
    // Lazy circular require: search-fetcher ↔ site-registry reference each other via runtime require() in Node.
    // Must remain lazy inside function body to avoid breaking module load order at startup.
    if (typeof require === "function") {
      try {
        const sf = require("./search-fetcher.js");
        if (sf && typeof sf.parseListingHtml === "function") {
          return sf.parseListingHtml(html, propertyId, canonicalId);
        }
      } catch {}
    }
    const ext = getExtractor();
    if (ext && typeof ext.extractListingData === "function") {
      return ext.extractListingData(html, urlStr);
    }
    return null;
  }

  // Vrbo site definition
  const vrboSite = {
    id: "vrbo",
    name: "Vrbo",
    matchesHostname: vrboMatchesHostname,
    isListingUrl: vrboIsListingUrl,
    isSearchUrl: vrboIsSearchUrl,
    getPropertyId: vrboGetPropertyId,
    getCanonicalFetchUrl: vrboGetCanonicalFetchUrl,
    decorateFetchUrl: vrboDecorateFetchUrl,
    getCacheKey: (propertyId) => `vrbow_cache_${propertyId}`,
    parseListingData: vrboParseListingData,
    searchCardSelector: DEFAULT_SEARCH_CARD_SELECTOR,
    cardContentSelector: DEFAULT_CARD_CONTENT_SELECTORS,
    pdpContentColumnSelector: DEFAULT_PDP_CONTENT_COLUMN_SELECTOR,
    pdpSectionCloseMatchers: DEFAULT_PDP_SECTION_CLOSE_MATCHERS,
    pdpSectionHeadingCategories: DEFAULT_PDP_SECTION_HEADING_CATEGORIES,
    pdpSectionLabelCategories: DEFAULT_PDP_SECTION_LABEL_CATEGORIES,
    pdpFallbackSectionLabel: DEFAULT_PDP_FALLBACK_SECTION_LABEL,
    pdpFallbackSectionShortLabel: DEFAULT_PDP_FALLBACK_SECTION_SHORT_LABEL,
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

  function isListingUrl(urlStr, baseUrl) {
    const site = getSiteForUrl(urlStr, baseUrl);
    return site ? site.isListingUrl(urlStr, baseUrl) : false;
  }

  function isSearchUrl(urlStr, baseUrl) {
    const site = getSiteForUrl(urlStr, baseUrl);
    return site ? site.isSearchUrl(urlStr, baseUrl) : false;
  }

  function getPropertyId(urlStr, baseUrl) {
    const site = getSiteForUrl(urlStr, baseUrl);
    return site ? site.getPropertyId(urlStr, baseUrl) : null;
  }

  function getCanonicalFetchUrl(urlStr, baseUrl) {
    const u = parseUrl(urlStr, baseUrl);
    if (!u) return null;
    const site = getSiteForUrl(urlStr, baseUrl) || getSiteForHostname(u.hostname);
    if (site && typeof site.getCanonicalFetchUrl === "function") {
      return site.getCanonicalFetchUrl(urlStr, baseUrl);
    }
    return `https://${u.hostname}${u.pathname}`;
  }

  function decorateFetchUrl(urlStr, baseUrl) {
    const u = parseUrl(urlStr, baseUrl);
    if (!u) return urlStr;
    const site = getSiteForUrl(urlStr, baseUrl) || getSiteForHostname(u.hostname);
    if (site && typeof site.decorateFetchUrl === "function") {
      return site.decorateFetchUrl(urlStr, baseUrl);
    }
    return urlStr;
  }

  function getSearchCardSelector(urlOrHostname) {
    const site = typeof urlOrHostname === "string"
      ? (getSiteForUrl(urlOrHostname) || getSiteForHostname(urlOrHostname))
      : urlOrHostname;
    return site?.searchCardSelector || DEFAULT_SEARCH_CARD_SELECTOR;
  }

  function getCardContentSelector(urlOrHostname) {
    const site = typeof urlOrHostname === "string"
      ? (getSiteForUrl(urlOrHostname) || getSiteForHostname(urlOrHostname))
      : urlOrHostname;
    return site?.cardContentSelector || DEFAULT_CARD_CONTENT_SELECTORS;
  }

  function getPdpContentColumnSelector(urlOrHostname) {
    const site = typeof urlOrHostname === "string"
      ? (getSiteForUrl(urlOrHostname) || getSiteForHostname(urlOrHostname))
      : urlOrHostname;
    return site?.pdpContentColumnSelector || DEFAULT_PDP_CONTENT_COLUMN_SELECTOR;
  }

  // Bundled rather than five near-identical getters: all five pieces are
  // always consumed together by findSectionHeadingForElement /
  // shortSourceLabel.
  function getPdpSectionConfig(urlOrHostname) {
    const site = typeof urlOrHostname === "string"
      ? (getSiteForUrl(urlOrHostname) || getSiteForHostname(urlOrHostname))
      : urlOrHostname;
    return {
      closeMatchers: site?.pdpSectionCloseMatchers || DEFAULT_PDP_SECTION_CLOSE_MATCHERS,
      headingCategories: site?.pdpSectionHeadingCategories || DEFAULT_PDP_SECTION_HEADING_CATEGORIES,
      labelCategories: site?.pdpSectionLabelCategories || DEFAULT_PDP_SECTION_LABEL_CATEGORIES,
      fallbackLabel: site?.pdpFallbackSectionLabel || DEFAULT_PDP_FALLBACK_SECTION_LABEL,
      fallbackShortLabel: site?.pdpFallbackSectionShortLabel || DEFAULT_PDP_FALLBACK_SECTION_SHORT_LABEL,
    };
  }

  function getCacheKey(urlOrSite, propertyId) {
    const site = typeof urlOrSite === "string"
      ? (getSiteForUrl(urlOrSite) || getSiteForHostname(urlOrSite))
      : urlOrSite;
    if (site && typeof site.getCacheKey === "function") {
      return site.getCacheKey(propertyId);
    }
    return `vrbow_cache_${propertyId}`;
  }

  function parseListingData(urlOrSite, html, propertyIdOrUrl, canonicalIdOrPropId, canonicalId) {
    const site = typeof urlOrSite === "string"
      ? (getSiteForUrl(urlOrSite) || getSiteForHostname(urlOrSite))
      : urlOrSite;

    let urlStr = typeof urlOrSite === "string" ? urlOrSite : "";
    let propertyId = propertyIdOrUrl;
    let effectiveCanonicalId = canonicalIdOrPropId;
    if (
      typeof propertyIdOrUrl === "string" &&
      (propertyIdOrUrl.startsWith("http://") ||
        propertyIdOrUrl.startsWith("https://") ||
        propertyIdOrUrl.startsWith("/"))
    ) {
      urlStr = propertyIdOrUrl;
      propertyId = canonicalIdOrPropId;
      effectiveCanonicalId = canonicalId;
    }

    if (site && typeof site.parseListingData === "function") {
      return site.parseListingData(
        html,
        urlStr,
        propertyId,
        effectiveCanonicalId
      );
    }
    const ext = getExtractor();
    if (ext && typeof ext.extractListingData === "function") {
      return ext.extractListingData(html, urlStr);
    }
    return null;
  }

  function registerSite(site) {
    if (!site || !site.id) return;
    const idx = SITES.findIndex((s) => s.id === site.id);
    if (idx >= 0) SITES[idx] = site;
    else SITES.push(site);
  }

  function unregisterSite(siteId) {
    const idx = SITES.findIndex((s) => s.id === siteId);
    if (idx >= 0) SITES.splice(idx, 1);
  }

  return {
    getSiteForUrl,
    getSiteForHostname,
    isListingUrl,
    isSearchUrl,
    getPropertyId,
    getCanonicalFetchUrl,
    decorateFetchUrl,
    getSearchCardSelector,
    getCardContentSelector,
    getPdpContentColumnSelector,
    getPdpSectionConfig,
    getCacheKey,
    parseListingData,
    registerSite,
    unregisterSite,
    getAllSites: () => [...SITES],
  };
});
