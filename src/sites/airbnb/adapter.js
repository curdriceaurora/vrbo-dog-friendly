// sites/airbnb/adapter.js
// Airbnb site adapter — registers with shared/site-registry.js the same way
// a future third site would. See issue #12 for the research behind the
// choices below (verified against 6 live listings before writing this).
//
// Airbnb's data model is genuinely different from Vrbo's, not just a
// different set of selectors:
//   - No window.__APOLLO_STATE__ — Airbnb doesn't use Apollo Client.
//   - The real source is <script id="data-deferred-state-0">, containing
//     `niobeClientData` — Airbnb's Relay/GraphQL SSR payload. It's plain
//     DOM text content, readable directly from the isolated content-script
//     world via document.getElementById(...).textContent + JSON.parse.
//     No MAIN-world bridge script needed (unlike Vrbo's page-bridge.js,
//     which exists only because Vrbo's data sits on `window`).
//   - Listing ids run up to 19 digits in the wild (past
//     Number.MAX_SAFE_INTEGER) — must stay a string end-to-end.
//
// Search-results badging is a separate, Vrbo-only, off-by-default
// experimental feature — not part of this adapter. isSearchUrl always
// returns false so no search-page code path ever activates for Airbnb.

// registryModule is shared/site-registry.js, passed in the same way
// site-registry.js itself receives extract.js — a real module dependency,
// not a globalThis lookup deferred to call time, so this adapter's own
// functions don't depend on load order beyond "site-registry.js loaded
// before this file" (already required by manifest.json either way).
// Reuses its parseUrl instead of keeping a second copy of the same
// three-branch URL-parsing/error-swallowing logic with a different
// hardcoded default origin.
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    let registryModule = null;
    try {
      registryModule = require("../../shared/site-registry.js");
    } catch {}
    const api = factory(registryModule);
    module.exports = api;
    if (typeof globalThis !== "undefined") {
      globalThis.VdpAirbnbAdapter = api;
      if (globalThis.VdpSiteRegistry && typeof globalThis.VdpSiteRegistry.registerSite === "function") {
        globalThis.VdpSiteRegistry.registerSite(api.airbnbSite);
      }
    }
  } else {
    const api = factory(root.VdpSiteRegistry);
    root.VdpAirbnbAdapter = api;
    // Self-register with the shared registry as soon as both are loaded.
    // manifest.json lists shared/site-registry.js before this file, so the
    // registry is always present here in the real extension; guarded for
    // any context (e.g. a future bundler) that might load this alone.
    if (root.VdpSiteRegistry && typeof root.VdpSiteRegistry.registerSite === "function") {
      root.VdpSiteRegistry.registerSite(api.airbnbSite);
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (registryModule) {
  "use strict";

  // Delegates to site-registry.js's parseUrl with Airbnb's own default
  // origin. Falls back to null (not a local reimplementation) if the
  // registry module genuinely isn't available — as unreachable in
  // practice as the other "registry unavailable" cases already accepted
  // elsewhere in this codebase (manifest.json guarantees load order).
  function parseUrl(urlStr, baseUrl) {
    if (!registryModule || typeof registryModule.parseUrl !== "function") return null;
    return registryModule.parseUrl(urlStr, baseUrl, "https://www.airbnb.com");
  }

  function airbnbMatchesHostname(hostname) {
    if (!hostname || typeof hostname !== "string") return false;
    return /(^|\.)airbnb\.com$/i.test(hostname);
  }

  // /rooms/<numericId> only.
  //   - /rooms/plus/<id>: Airbnb Plus, discontinued 2022 — a dead route,
  //     deliberately excluded rather than guessed at.
  //   - /luxury/... (Luxe): a distinct, unverified surface — not added
  //     until confirmed live against a real listing, same evidence bar as
  //     everything else in this adapter.
  //   - /s/..., profile, and help pages: not listings, excluded by the
  //     pattern requiring exactly /rooms/<digits> with nothing else.
  const LISTING_PATH = /^\/rooms\/(\d+)\/?$/i;

  function airbnbIsListingUrl(urlStr, baseUrl) {
    const u = parseUrl(urlStr, baseUrl);
    if (!u || !airbnbMatchesHostname(u.hostname)) return false;
    return LISTING_PATH.test(u.pathname);
  }

  // Search-results card/badge integration is out of scope for this adapter
  // (see the module comment above) — always false.
  function airbnbIsSearchUrl() {
    return false;
  }

  function airbnbGetPropertyId(urlStr, baseUrl) {
    const u = parseUrl(urlStr, baseUrl);
    if (!u || !airbnbMatchesHostname(u.hostname)) return null;
    const m = LISTING_PATH.exec(u.pathname);
    // Deliberately a plain string return — never parseInt/Number/arithmetic
    // here or anywhere this id flows (caching, dedup, comparisons). Real
    // ids observed up to 19 digits, past Number.MAX_SAFE_INTEGER (2^53-1);
    // coercing to a number would silently corrupt the id.
    return m ? m[1] : null;
  }

  function airbnbGetCanonicalFetchUrl(urlStr, baseUrl) {
    const u = parseUrl(urlStr, baseUrl);
    if (!u || !airbnbMatchesHostname(u.hostname)) return null;
    return `https://www.airbnb.com${u.pathname}`;
  }

  function airbnbDecorateFetchUrl(urlStr) {
    // No query-param decoration needed today (unlike Vrbo's locale/siteid
    // pair) — background search-page prefetching doesn't run for this site
    // (see isSearchUrl above), so this is currently unused, but kept as a
    // real passthrough rather than omitted, matching the registry's
    // interface shape for a future search-page follow-up.
    return urlStr;
  }

  // ---------- structured PDP data ----------

  // Section-boilerplate present on every listing regardless of host,
  // matches /pet/i, and describes what does NOT count as a pet (service
  // animals) — would poison the corpus as a false policy line on every
  // single listing if not explicitly skipped. Confirmed via
  // sectionComponentType, not by matching its text (text wording could
  // change; the component type is Airbnb's own stable discriminator).
  const SKIP_SECTION_COMPONENT_TYPES = new Set(["WHAT_COUNTS_AS_A_PET"]);

  // Leaf keys observed holding real listing prose across the object
  // shapes seen in practice (Html.htmlText, BasicListItem.title,
  // AmenityItem.title, UGCText.localizedString, LocalizedContent.
  // localizedContent). Deliberately an allowlist of key NAMES, not
  // __typenames — Airbnb's payload has many more __typenames than we've
  // catalogued, and a __typename allowlist would silently miss whatever
  // we haven't seen yet (this is exactly the gap found during #12's
  // research: the real buried-fee example sits under
  // GeneralListContentSection/PDP_DESCRIPTION_MODAL, neither of which the
  // original issue text anticipated). Walking by leaf key name instead of
  // __typename means an unfamiliar SECTION shape still gets its text
  // collected as long as the leaf itself uses one of these key names —
  // it's a narrower allowlist (4 keys vs. dozens of typenames), not a
  // fundamentally different guarantee: a listing whose prose sits under a
  // still-different leaf key (e.g. a hypothetical `plainText`/`subtitle`)
  // would be silently missed the same way a __typename allowlist would
  // miss an unfamiliar typename. Some allowlisting is unavoidable against
  // an unversioned internal payload; expanding this set (or adding
  // another schema-independent signal, the way readListingTitleCandidates
  // above pairs its JSON-path reads with document.title) is the fix when
  // a future listing's fixture turns up something this set misses.
  const LEAF_TEXT_KEYS = new Set(["htmlText", "title", "localizedString", "localizedContent"]);

  // Keys that are structurally never human-readable prose, so never worth
  // treating as candidate text even when they happen to be strings (ids,
  // urls, and enum-like discriminators). Without this, e.g. SEO link paths
  // like "/san-diego-ca/stays/pet-friendly" would pass the pet-keyword
  // filter downstream purely because of the URL slug, not real content.
  const SKIP_KEY_PATTERN = /(^__typename$|^id$|Id$|^url$|Url$|^path$|Path$|^sectionComponentType$|^componentType$)/;

  // Subtrees that are pure SEO/marketing metadata, not policy content —
  // confirmed against real fixtures: seoLinks entries like "Pet-friendly
  // vacation rentals in San Diego" and their /san-diego-ca/stays/
  // pet-friendly paths pass the pet-keyword filter downstream purely
  // because of the marketing copy/URL slug, not because they say anything
  // about this listing's actual policy. Skipped by key name (not
  // __typename) at the point of descent — these are structural grouping
  // keys, never leaf text themselves, so skipping descent into them
  // removes the whole subtree cleanly regardless of what's nested inside.
  const SKIP_DESCEND_KEYS = new Set(["seoLinks", "seoFeatures", "metadata"]);

  function stripHtml(s) {
    // The entity decoding below is a deliberately small local subset, not a
    // duplicate of extract.js's getSentences() (which runs its own, more
    // complete decoder downstream on every sentence). It's kept here
    // because this function's output also feeds the exact-string title-dedup
    // comparison below (titleCandidates.has(it.text)) — that comparison
    // needs this text decoded the same way the title-candidate strings
    // already are, before getSentences ever runs.
    return s
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&#8217;|&rsquo;/g, "’")
      .replace(/&quot;/g, '"')
      // Horizontal whitespace only — preserve the \n's from <br> above (and
      // any literal \n already in the JSON text). extract.js's
      // getSentences() splits on \n+ to separate sentences in multi-line
      // blobs; collapsing them away here would fuse e.g. "Dogs welcome" and
      // "No smoking allowed" into one sentence before getSentences ever
      // sees a boundary, letting the unrelated clause ride along into
      // otherNotes instead of being evaluated (and discarded) on its own.
      // getSentences does its own final `\s+` -> " " normalization per
      // split sentence, so nothing downstream depends on this collapsing
      // newlines itself.
      .replace(/[^\S\r\n]+/g, " ")
      .trim();
  }

  // Walks the ENTIRE payload rather than a fixed list of known-relevant
  // fields — mirrors page-bridge.js's approach for Vrbo's Apollo state,
  // for the same reason: hosts (and Airbnb's own schema) put pet info in
  // inconsistent places, so reading only the 2-3 fields seen in the
  // sampled listings would miss the next listing's variant. The generic
  // walk plus the shared downstream pet-keyword filter (buildCorpus in
  // extract.js) does the actual relevance decision — this function's job
  // is just to surface candidate {header, section, text} items broadly and
  // fail safely (bounded depth, try/catch at the call site) rather than
  // to be a precise pet-policy parser.
  function walkNiobeNode(node, ctx, out, depth) {
    if (node == null || depth > 30) return;
    if (Array.isArray(node)) {
      for (const item of node) walkNiobeNode(item, ctx, out, depth + 1);
      return;
    }
    if (typeof node !== "object") return;

    if (SKIP_SECTION_COMPONENT_TYPES.has(node.sectionComponentType)) return;

    // Track the nearest enclosing section as context for children. A
    // __typename ending in "Section" is (empirically) Airbnb's own
    // convention for a section/group container; its title becomes the
    // header context handed down to whatever it contains.
    let nextCtx = ctx;
    if (typeof node.__typename === "string" && /Section$/.test(node.__typename)) {
      const title = typeof node.title === "string" && node.title.trim() ? node.title.trim() : ctx.header;
      nextCtx = { header: title, section: title || ctx.section };
    }

    for (const k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      if (SKIP_KEY_PATTERN.test(k) || SKIP_DESCEND_KEYS.has(k)) continue;
      const v = node[k];
      if (typeof v === "string" && LEAF_TEXT_KEYS.has(k) && v.trim().length > 1) {
        out.push({ header: nextCtx.header, section: nextCtx.section || nextCtx.header || "Listing details", text: stripHtml(v) });
      } else if (v && typeof v === "object") {
        walkNiobeNode(v, nextCtx, out, depth + 1);
      }
    }
  }

  // The listing's own title/name shows up verbatim as a leaf-text
  // candidate from a couple of known wrapper shapes (pdpPresentation.title,
  // description.name) — real content by the walker's own rules (a
  // localizedString leaf), but a redundant, low-value "note" when it's
  // just the listing repeating its own name back. Deliberately NOT
  // excluded by skipping those keys structurally — hostInfo.overview.title
  // has the exact same object-wrapper shape and IS real content (a host's
  // profile overview), so a key-name-based skip would risk dropping
  // legitimate text there too. Comparing against the actual known title
  // VALUE is precise where a structural skip would be a guess; best-effort
  // only (a couple of specific, defensive reads) since this is a cosmetic
  // dedup, not a data-completeness concern — if Airbnb moves these fields,
  // this silently stops filtering rather than losing anything.
  function readListingTitleCandidates(data) {
    const candidates = new Set();
    try {
      const node = data && data.niobeClientData && data.niobeClientData[0] && data.niobeClientData[0][1] && data.niobeClientData[0][1].data && data.niobeClientData[0][1].data.node;
      const t1 = node && node.pdpPresentation && node.pdpPresentation.title && node.pdpPresentation.title.content && node.pdpPresentation.title.content.localizedString;
      const t2 = node && node.description && node.description.name && node.description.name.localizedString;
      if (typeof t1 === "string" && t1.trim()) candidates.add(t1.trim());
      if (typeof t2 === "string" && t2.trim()) candidates.add(t2.trim());
    } catch {
      // best-effort — an unexpected shape here just means no titles to
      // filter, not a failure of the actual extraction below.
    }
    // Additional, schema-independent signal: the rendered page's own
    // <title>, which doesn't depend on guessing at niobeClientData's
    // internal field names the way the two reads above do. Purely
    // additive — can only catch more of the same noise, never regress
    // the two candidates already verified against the real fixtures.
    // Airbnb's real <title> is "<bare name> - Apartments for Rent in
    // <city>... - Airbnb" (confirmed against a live capture); the bare
    // name before the first " - " is exactly the string that leaks from
    // pdpPresentation.title/description.name above, so this also still
    // catches the noise if Airbnb ever restructures those specific JSON
    // paths.
    try {
      if (typeof document !== "undefined" && typeof document.title === "string" && document.title.trim()) {
        const fullTitle = document.title.trim();
        candidates.add(fullTitle);
        const bareName = fullTitle.split(" - ")[0].trim();
        if (bareName) candidates.add(bareName);
      }
    } catch {
      // same best-effort reasoning as above.
    }
    return candidates;
  }

  // Reads the current page's #data-deferred-state-0 script tag and returns
  // a { items: [{header, section, text}, ...] } payload in the same shape
  // buildCorpus() (extract.js) already consumes for Vrbo's Apollo path —
  // called generically from content.js's scan(), same call site Vrbo's
  // window.__APOLLO_STATE__-derived payload goes through.
  //
  // Fails gracefully at every step: missing script tag, malformed JSON, an
  // unexpected top-level shape, or an exception mid-walk all return null
  // rather than throwing — content.js already falls back to its DOM
  // text-scan path when the structured payload is empty, so a null here
  // degrades to "scan the visible page text instead," not a crash.
  function airbnbGetPdpStructuredPayload() {
    try {
      if (typeof document === "undefined") return null;
      const el = document.getElementById("data-deferred-state-0");
      if (!el || !el.textContent) return null;
      const data = JSON.parse(el.textContent);
      const niobeClientData = data && data.niobeClientData;
      if (!Array.isArray(niobeClientData)) return null;

      const items = [];
      walkNiobeNode(niobeClientData, { header: null, section: null }, items, 0);
      const titleCandidates = readListingTitleCandidates(data);
      const filteredItems = titleCandidates.size ? items.filter((it) => !titleCandidates.has(it.text)) : items;
      return { items: filteredItems };
    } catch (e) {
      if (typeof console !== "undefined" && typeof console.warn === "function") {
        console.warn("vrbow: failed to read Airbnb structured PDP data", e);
      }
      return null;
    }
  }

  // getCanonicalFetchUrl / decorateFetchUrl / getCacheKey exist for
  // symmetry with the registry's site-adapter interface, but have no live
  // caller today: they only matter to the search-fetcher queue's
  // background-prefetch path, which only runs when isSearchUrl can be
  // true somewhere — and isSearchUrl is always false here (see above).
  // Kept rather than omitted so the shape stays complete for whenever
  // Airbnb search-results support is scoped as its own follow-up, instead
  // of these having to be reconstructed from scratch at that point.
  //
  // pdpContentColumnSelector / pdpSection* are deliberately NOT declared
  // here — this issue's scope is PDP data extraction only (see
  // isSearchUrl above and #12's own scope notes on search-results being
  // out of scope). Leaving them undefined means the registry's
  // getPdpContentColumnSelector/getPdpSectionConfig fall back to their
  // Vrbo-shaped DEFAULT_* values (site-registry.js) for Airbnb pages too
  // — those Vrbo-specific data-stid selectors simply never match
  // Airbnb's DOM, so this degrades harmlessly to the generic
  // ancestor-heading walk and constrained-mode panel positioning
  // (confirmed by e2e/airbnb-listing.spec.js), not a deliberate Airbnb
  // layout choice. Fine for v1; a real Airbnb-specific PDP layout (if the
  // panel-beside-gallery positioning from #44 is ever wanted here too)
  // is its own follow-up.
  const airbnbSite = {
    id: "airbnb",
    name: "Airbnb",
    matchesHostname: airbnbMatchesHostname,
    isListingUrl: airbnbIsListingUrl,
    isSearchUrl: airbnbIsSearchUrl,
    getPropertyId: airbnbGetPropertyId,
    getCanonicalFetchUrl: airbnbGetCanonicalFetchUrl,
    decorateFetchUrl: airbnbDecorateFetchUrl,
    getCacheKey: (propertyId) => `vrbow_cache_airbnb_${propertyId}`,
    getPdpStructuredPayload: airbnbGetPdpStructuredPayload,
  };

  return { airbnbSite, walkNiobeNode, stripHtml };
});
