// Runs in the PAGE's own JS world (manifest "world": "MAIN"), because
// window.__APOLLO_STATE__ lives in the page's global scope and is not
// reachable from a normal (isolated-world) content script.
//
// Vrbo's House Rules / Policies section is lazy-mounted (it's an empty
// placeholder in the DOM until you scroll to it), and "About this
// property" text is CSS-clamped behind a "See more" toggle. But in both
// cases the FULL underlying text was already fetched via GraphQL and is
// sitting in window.__APOLLO_STATE__ as soon as the page loads — reading
// it here means we don't depend on the user (or us) scrolling anything
// into view or clicking anything open.
//
// Hosts put pet info in inconsistent places (a structured "Pets" row
// under House Rules, freeform prose in "About this property", a
// headerless note at the bottom of House Rules, "Important information",
// etc.), and Vrbo's schema for this isn't guaranteed to stay identical
// forever. So instead of only reading the 2-3 fields we've seen pet info
// live in, we walk the ENTIRE property data object and pull out every
// piece of text, tagged with whatever heading it was nested under. The
// content script then filters that for pet/dog relevance itself. This
// way, any subsection a host uses for pet info gets caught, and if Vrbo
// renames/restructures fields, we still catch plain-text mentions.
//
// Bridges data to the isolated-world content script via CustomEvents on
// `window`, since the two worlds don't share objects directly.

(() => {
  const REQUEST_EVENT = "vdp-request-apollo-data";
  const DATA_EVENT = "vdp-apollo-data";
  const SEARCH_REQUEST_EVENT = "vdp-search-apollo-request";
  const SEARCH_DATA_EVENT = "vdp-search-apollo-data";
  const NAV_EVENT = "vdp-locationchange";

  let lastPayloadKey = null;

  function resolveRef(state, node, visited) {
    if (node && typeof node === "object" && typeof node.__ref === "string") {
      if (visited.has(node.__ref)) return null;
      visited.add(node.__ref);
      return state[node.__ref] || null;
    }
    return node;
  }

  // Resolve the PropertyInfo record for a listing, in three tiers.
  //
  // Tier 1 (exact key) used to be the whole function, and it silently stopped
  // working: Vrbo's URLs carry a Vrbo property id (/2488800) while Apollo keys
  // the record by the EXPEDIA id (PropertyInfo:71616755). Measured across 6
  // saved captures the two never agree, so every listing missed, extraction
  // returned null, and the extension quietly fell back to scraping the DOM.
  //
  // Tier 2 (id-field scan) mirrors the equivalent scan in search-fetcher.js.
  // Note it does NOT fix the case above on its own — the live record carries
  // no propertyId/vrboPropertyId/expediaPropertyId at all, only `id` holding
  // the Expedia id. It is kept because it is cheap, unambiguous when the data
  // does carry a usable field, and covers page shapes we have not sampled.
  //
  // Tier 3 (sole record) is what actually recovers the observed case, and it
  // is a heuristic rather than an id match: a listing page describes exactly
  // one property, so a lone PropertyInfo record is that property. It is
  // therefore gated behind an explicit opt-in — see the call sites.
  function findApolloRoot(state, id, opts = {}) {
    const { allowSoleRecord = false } = opts;
    if (!state || !id || typeof state !== "object") return null;

    const strId = String(id);
    const lowerId = strId.toLowerCase();

    const candidates = [
      `PropertyInfo:${strId}`,
      `propertyInfo:${strId}`,
      `PropertyInfo:${lowerId}`,
      `propertyInfo:${lowerId}`,
    ];

    for (const key of candidates) {
      if (state[key]) return { key, root: state[key] };
    }

    const propertyInfoMatches = [];

    for (const key in state) {
      if (!Object.prototype.hasOwnProperty.call(state, key)) continue;
      if (!key.toLowerCase().startsWith("propertyinfo:")) continue;

      propertyInfoMatches.push(key);

      if (key.toLowerCase() === `propertyinfo:${lowerId}`) {
        return { key, root: state[key] };
      }

      const node = state[key];
      if (!node || typeof node !== "object") continue;

      // Compared as strings throughout. Vrbo/Expedia ids are numeric-looking
      // but must never be coerced — the same rule the Airbnb adapter follows
      // for its 19-digit ids.
      const nodeIds = [
        node.propertyId,
        node.vrboPropertyId,
        node.expediaPropertyId,
        node.id,
      ].filter((value) => value != null).map(String);

      if (nodeIds.includes(strId)) {
        return { key, root: node };
      }
    }

    if (allowSoleRecord && propertyInfoMatches.length === 1) {
      const key = propertyInfoMatches[0];
      return { key, root: state[key] };
    }

    return null;
  }

  // Walk the full property object, collecting every leaf string found
  // under a "value"/"text" key, tagged with the nearest enclosing
  // header text (e.g. "Pets", "House Rules", "About this property").
  function walkCollect(state, node, headerCtx, sectionCtx, out, visited, depth) {
    if (node == null || depth > 40) return;
    const resolved = resolveRef(state, node, visited);
    if (resolved == null) return;
    node = resolved;

    if (Array.isArray(node)) {
      for (const item of node) walkCollect(state, item, headerCtx, sectionCtx, out, visited, depth + 1);
      return;
    }
    if (typeof node !== "object") return;

    let nextHeader = headerCtx;
    let nextSection = sectionCtx;
    const headerText = node?.header?.text;
    if (typeof headerText === "string" && headerText.trim()) {
      nextHeader = headerText.trim();
      // Track a coarser "section" label too (House Rules / About this
      // property / etc.) so we can point the user roughly the right way
      // even when the fine-grained header is something like "Pets".
      if (/house rules|polic|important information/i.test(nextHeader)) nextSection = "House Rules / Policies";
      else if (/about this property|about this space|about this listing/i.test(nextHeader)) nextSection = "About this property";
      else if (!nextSection) nextSection = nextHeader;
    }
    if (typeof node.sectionName === "string" && node.sectionName.trim()) {
      nextHeader = node.sectionName.trim();
      if (/house rules|polic/i.test(nextHeader)) nextSection = "House Rules / Policies";
    }

    for (const k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      const v = node[k];
      if ((k === "value" || k === "text" || k === "body" || k === "description") && typeof v === "string" && v.trim() && v.trim().length > 1) {
        out.push({ header: nextHeader, section: nextSection || nextHeader, text: v.trim() });
      } else if (v && typeof v === "object") {
        walkCollect(state, v, nextHeader, nextSection, out, visited, depth + 1);
      }
    }
  }

  function getListingIdFromUrl() {
    const m = /(?:\/pdp(?:\/lo)?\/|\/vacation-rentals?(?:\/p)?\/p?|\/)(p?\d+[a-z0-9]*)(?:\/|\?|$)/i.exec(location.pathname);
    if (!m) return null;
    let id = m[1];
    if (/^p\d+/i.test(id)) id = id.slice(1);
    return id;
  }

  function extractFromApollo() {
    const state = window.__APOLLO_STATE__;
    if (!state || typeof state !== "object") return null;

    const currentId = getListingIdFromUrl();
    if (!currentId) return null;

    // PDP/listing page: safe to use the sole-PropertyInfo fallback, because
    // this page describes exactly one property. This is the tier that
    // actually recovers Expedia-keyed records.
    const match = findApolloRoot(state, currentId, { allowSoleRecord: true });
    if (!match || !match.root) return null;
    const { key: infoKey, root } = match;

    const out = [];
    walkCollect(state, root, null, null, out, new Set(), 0);

    // De-dupe identical (header, text) pairs while preserving first-seen order.
    const seen = new Set();
    const items = [];
    for (const item of out) {
      const key = item.header + "||" + item.text;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }

    return {
      ok: true,
      propertyId: infoKey.split(":")[1] || null,
      ts: Date.now(),
      items, // [{header, section, text}, ...] — everything the page already fetched
    };
  }

  // Search pages have no listing ID in the URL, so extractFromApollo() can't
  // find the current property — yet Vrbo's search results page also carries
  // window.__APOLLO_STATE__, usually with one PropertyInfo:<id> record per
  // result card, using the same graph shape as the listing page. Read exactly
  // the records the content script asked for (bounded set), walking ONLY those
  // graphs, so a search page can badge its cards without issuing a single
  // listing request. "No usable record" is a normal outcome, not an error:
  // the caller falls through to the queue when a property has no entry here.
  function extractFromSearchApollo(propertyIds) {
    const state = window.__APOLLO_STATE__;
    if (!state || typeof state !== "object") return { ok: true, results: {} };
    const ids = Array.isArray(propertyIds) ? propertyIds.filter((id) => typeof id === "string" && id) : [];
    const results = {};
    for (const id of ids.slice(0, 40)) {
      // Search page: NEVER pass allowSoleRecord. A results page holds many
      // PropertyInfo records (and can hold a single stale/unrelated one), so
      // falling back to "the only record" would badge a card with a different
      // property's pet policy. The caller supplied explicit ids; resolving to
      // nothing is a normal outcome that falls through to the fetch queue.
      const match = findApolloRoot(state, id);
      if (!match || !match.root) continue;
      const root = match.root;
      const out = [];
      walkCollect(state, root, null, null, out, new Set(), 0);
      const seen = new Set();
      const items = [];
      for (const item of out) {
        const key = item.header + "||" + item.text;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(item);
      }
      results[id] = { propertyId: id, ts: Date.now(), items };
    }
    return { ok: true, results };
  }

  function payloadKey(payload) {
    if (!payload) return "none";
    return payload.propertyId + "|" + payload.items.length + "|" + (payload.items[payload.items.length - 1]?.text.length || 0);
  }

  function tryDispatch(force) {
    const payload = extractFromApollo();
    const key = payloadKey(payload);
    if (!force && key === lastPayloadKey) return payload;
    lastPayloadKey = key;
    // Set independently of the payload: __vdpBridgeData is legitimately null
    // when resolution finds nothing, so `!!__vdpBridgeData` cannot tell
    // "never ran" from "ran and resolved nothing". Diagnostics read this flag
    // instead. __vdpBridgeData's own semantics are deliberately unchanged —
    // content.js and the e2e suite depend on the null-payload behaviour.
    window.__vdpBridgeRan = true;
    window.__vdpBridgeData = payload;
    window.dispatchEvent(new CustomEvent(DATA_EVENT, { detail: payload }));
    return payload;
  }

  // Poll aggressively at first and whenever navigation occurs
  // (Apollo cache populates async after mount / GraphQL response).
  let fastPollTimer = null;
  function startFastPoll() {
    if (fastPollTimer) clearInterval(fastPollTimer);
    let attempts = 0;
    fastPollTimer = setInterval(() => {
      attempts++;
      const payload = tryDispatch(false);
      if ((payload && payload.items && payload.items.length > 5) || attempts > 30) {
        clearInterval(fastPollTimer);
        fastPollTimer = null;
      }
    }, 350);
  }
  startFastPoll();

  // Slow background poll to catch SPA navigation to a different listing.
  // extractFromApollo() walks the whole PropertyInfo graph, so running it
  // flat-out forever burns CPU on a page that has long since settled:
  // back off while the payload keeps coming back identical, and skip the
  // walk entirely in a backgrounded tab. Any real navigation resets the
  // interval, and the content script's explicit request still forces an
  // immediate dispatch regardless.
  const POLL_MIN_MS = 2500;
  const POLL_MAX_MS = 20000;
  let pollDelay = POLL_MIN_MS;
  let lastPollUrl = location.href;

  (function slowPoll() {
    setTimeout(() => {
      if (location.href !== lastPollUrl) {
        lastPollUrl = location.href;
        pollDelay = POLL_MIN_MS;
        startFastPoll();
      }
      if (document.visibilityState !== "hidden") {
        const before = lastPayloadKey;
        tryDispatch(false);
        pollDelay = lastPayloadKey === before ? Math.min(pollDelay * 2, POLL_MAX_MS) : POLL_MIN_MS;
      }
      slowPoll();
    }, pollDelay);
  })();

  // Respond on demand, in case the isolated content script's listener
  // attaches after we already dispatched once or after an SPA hop.
  window.addEventListener(REQUEST_EVENT, () => {
    tryDispatch(true);
    startFastPoll();
  });

  // Search-page fast path: the content script asks for the exact property
  // IDs it has discovered on the results page, and gets back only the
  // matching PropertyInfo:<id> graphs. The response is dispatched
  // synchronously inside this handler, so the content script can read the
  // result in the same tick it makes the request and decide whether to
  // skip its queued listing fetch entirely.
  window.addEventListener(SEARCH_REQUEST_EVENT, (e) => {
    const detail = e && e.detail ? e.detail : {};
    const propertyIds = Array.isArray(detail.propertyIds) ? detail.propertyIds : [];
    const payload = extractFromSearchApollo(propertyIds);
    payload.requestId = detail.requestId || null;
    window.__vdpSearchBridgeData = payload;
    window.dispatchEvent(new CustomEvent(SEARCH_DATA_EVENT, { detail: payload }));
  });

  // SPA navigation signal for the content script. This patch has to live
  // here in the MAIN world: an isolated-world content script gets its own
  // JS realm, so assigning history.pushState there would never intercept
  // Vrbo's own router calls. Events dispatched on window, unlike object
  // mutations, do cross into the isolated world.
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    if (typeof original !== "function") continue;
    history[method] = function (...args) {
      const ret = original.apply(this, args);
      startFastPoll();
      window.dispatchEvent(new Event(NAV_EVENT));
      return ret;
    };
  }
})();
