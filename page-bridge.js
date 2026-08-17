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

    for (const [k, v] of Object.entries(node)) {
      if ((k === "value" || k === "text") && typeof v === "string" && v.trim() && v.trim().length > 1) {
        out.push({ header: nextHeader, section: nextSection || nextHeader, text: v.trim() });
      } else if (v && typeof v === "object") {
        walkCollect(state, v, nextHeader, nextSection, out, visited, depth + 1);
      }
    }
  }

  function getListingIdFromUrl() {
    const m = /\/(\d+[a-z0-9]*)(?:\/|\?|$)/i.exec(location.pathname);
    return m ? m[1] : null;
  }

  function extractFromApollo() {
    const state = window.__APOLLO_STATE__;
    if (!state || typeof state !== "object") return null;

    const currentId = getListingIdFromUrl();
    let infoKey = null;
    if (currentId) {
      infoKey = Object.keys(state).find((k) => k.toLowerCase() === `propertyinfo:${currentId.toLowerCase()}`);
    }
    if (!infoKey) {
      infoKey = Object.keys(state).find((k) => k.startsWith("PropertyInfo:"));
    }
    if (!infoKey) return null;
    const root = state[infoKey];
    if (!root) return null;

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

  function payloadKey(payload) {
    if (!payload) return "none";
    return payload.propertyId + "|" + payload.items.length + "|" + (payload.items[payload.items.length - 1]?.text.length || 0);
  }

  function tryDispatch(force) {
    const payload = extractFromApollo();
    const key = payloadKey(payload);
    if (!force && key === lastPayloadKey) return payload;
    lastPayloadKey = key;
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
