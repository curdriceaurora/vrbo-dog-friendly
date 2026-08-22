// test/page-bridge-root-resolution.test.js
// Covers findApolloRoot()'s three-tier resolution in src/content/page-bridge.js.
//
// The bug this exists to prevent regressing: Vrbo listing URLs carry a Vrbo
// property id (/2488800) while __APOLLO_STATE__ keys the record by the
// EXPEDIA id (PropertyInfo:71616755). Exact-key lookup — the bridge's only
// tier before this — missed on every listing measured, so extraction returned
// null and the extension silently fell back to scraping the DOM.
//
// findApolloRoot is not exported (page-bridge.js is an IIFE in the page's own
// world), so these drive it through its two real entry points instead:
// the listing path via the DATA_EVENT payload, and the search path via
// extractFromSearchApollo's request/response event pair. That also keeps the
// PDP-vs-search asymmetry under test, which is the part of this fix that
// could do damage if it were ever collapsed into one behaviour.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const BRIDGE_SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "src", "content", "page-bridge.js"),
  "utf8"
);

// A PropertyInfo record shaped like the real thing: pet text nested under a
// header, reachable only by walkCollect. Text is what proves the right record
// was resolved, not just that something was.
function propertyRecord(marker) {
  return {
    __typename: "PropertyInfo",
    summary: {
      header: { text: "House Rules" },
      items: [{ text: `${marker}: dogs allowed, 2 max` }],
    },
  };
}

function loadBridge(apolloState, pathname) {
  const listeners = new Map();
  const windowObj = {
    __APOLLO_STATE__: apolloState,
    location: { pathname, href: `https://www.vrbo.com${pathname}` },
    dispatchEvent(event) {
      const cbs = listeners.get(event.type);
      if (cbs) for (const cb of [...cbs]) cb(event);
      return true;
    },
    addEventListener(type, cb) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(cb);
    },
    removeEventListener(type, cb) {
      const cbs = listeners.get(type);
      if (cbs) cbs.delete(cb);
    },
  };
  windowObj.window = windowObj;
  windowObj.self = windowObj;

  class MockCustomEvent {
    constructor(type, opts) {
      this.type = type;
      this.detail = opts && opts.detail;
    }
  }

  const sandbox = {
    window: windowObj,
    location: windowObj.location,
    document: { visibilityState: "visible" },
    history: { pushState() {}, replaceState() {} },
    CustomEvent: MockCustomEvent,
    Event: MockCustomEvent,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(BRIDGE_SOURCE, sandbox);
  return { windowObj, MockCustomEvent };
}

// Listing path: force a dispatch and read the resulting payload.
function resolveOnListing(apolloState, pathname = "/2488800") {
  const { windowObj, MockCustomEvent } = loadBridge(apolloState, pathname);
  let payload;
  windowObj.addEventListener("vdp-apollo-data", (e) => { payload = e.detail; });
  windowObj.dispatchEvent(new MockCustomEvent("vdp-request-apollo-data"));
  return { payload, windowObj };
}

// Search path: ask for one id, read back the record map.
function resolveOnSearch(apolloState, requestedId) {
  const { windowObj, MockCustomEvent } = loadBridge(apolloState, "/Hotel-Search");
  let response;
  windowObj.addEventListener("vdp-search-apollo-data", (e) => { response = e.detail; });
  windowObj.dispatchEvent(
    new MockCustomEvent("vdp-search-apollo-request", {
      detail: { propertyIds: [requestedId], requestId: 1 },
    })
  );
  return response;
}

const textOf = (payload) => (payload?.items || []).map((i) => i.text).join(" | ");

describe("page-bridge findApolloRoot: tier 1 — exact key", () => {
  test("resolves PropertyInfo:<url id> when the namespaces agree", () => {
    const { payload } = resolveOnListing({ "PropertyInfo:2488800": propertyRecord("EXACT") });
    assert.ok(payload, "expected a payload");
    assert.equal(payload.propertyId, "2488800");
    assert.match(textOf(payload), /EXACT/);
  });
});

describe("page-bridge findApolloRoot: tier 2 — id-field scan", () => {
  test("resolves an Expedia-keyed record carrying vrboPropertyId matching the URL id", () => {
    const rec = propertyRecord("FIELDMATCH");
    rec.vrboPropertyId = "2488800";
    const { payload } = resolveOnListing({ "PropertyInfo:71616755": rec });
    assert.ok(payload, "expected the id-field scan to resolve the record");
    assert.match(textOf(payload), /FIELDMATCH/);
  });

  test("picks the field-matched record over an unrelated one, rather than guessing", () => {
    const wanted = propertyRecord("WANTED");
    wanted.propertyId = "2488800";
    const { payload } = resolveOnListing({
      "PropertyInfo:99999999": propertyRecord("OTHER"),
      "PropertyInfo:71616755": wanted,
    });
    assert.match(textOf(payload), /WANTED/);
    assert.doesNotMatch(textOf(payload), /OTHER/);
  });

  test("compares ids as strings — a numeric id field still matches without coercion", () => {
    const rec = propertyRecord("NUMERIC");
    rec.id = 71616755; // number, not string
    const { payload } = resolveOnListing({ "PropertyInfo:x": rec }, "/71616755");
    assert.ok(payload, "expected a numeric id field to match its string form");
    assert.match(textOf(payload), /NUMERIC/);
  });
});

describe("page-bridge findApolloRoot: tier 3 — sole-record fallback (PDP only)", () => {
  test("THE REGRESSION CASE: a lone Expedia-keyed record with no matching id field resolves on a listing page", () => {
    // Exactly the live shape measured on /2488800: one PropertyInfo keyed by
    // the Expedia id, whose only id field is that same Expedia id. No tier-1
    // or tier-2 match exists. Before this fix, this returned null on every
    // real Vrbo listing.
    const rec = propertyRecord("SOLE");
    rec.id = "71616755";
    const { payload } = resolveOnListing({ "PropertyInfo:71616755": rec });
    assert.ok(payload, "sole-record fallback did not resolve the real-world shape");
    assert.match(textOf(payload), /SOLE/);
  });

  test("does NOT fall back when several PropertyInfo records exist and none matches", () => {
    const { payload } = resolveOnListing({
      "PropertyInfo:1111": propertyRecord("A"),
      "PropertyInfo:2222": propertyRecord("B"),
      "PropertyInfo:3333": propertyRecord("C"),
    });
    assert.equal(payload, null, "must not guess between multiple candidate records");
  });

  test("returns null when there is no Apollo state at all", () => {
    const { payload } = resolveOnListing(undefined);
    assert.equal(payload, null);
  });
});

describe("page-bridge findApolloRoot: the search path must never inherit tier 3", () => {
  test("a sole unrelated record does NOT resolve for a requested search id", () => {
    // The damaging case: on a results page, falling back to "the only record"
    // would badge a card with a different property's pet policy. Search passes
    // explicit ids and must resolve nothing rather than guess.
    const rec = propertyRecord("WRONG-PROPERTY");
    rec.id = "71616755";
    const response = resolveOnSearch({ "PropertyInfo:71616755": rec }, "2488800");
    assert.ok(response && response.results, "expected a search response envelope");
    assert.equal(response.results["2488800"], undefined, "search must not fall back to the sole record");
  });

  test("but the search path still resolves a genuine id-field match", () => {
    const rec = propertyRecord("SEARCH-OK");
    rec.vrboPropertyId = "2488800";
    const response = resolveOnSearch({ "PropertyInfo:71616755": rec }, "2488800");
    const hit = response.results["2488800"];
    assert.ok(hit, "tier 2 should still work on the search path");
    assert.match(hit.items.map((i) => i.text).join(" "), /SEARCH-OK/);
  });
});

describe("page-bridge: run flag is independent of the payload", () => {
  test("__vdpBridgeRan is set even when resolution yields null", () => {
    // The distinction tools/live-check.js could not previously make: a null
    // payload was indistinguishable from the bridge never executing, which is
    // what made this bug hard to locate.
    const { windowObj, payload } = resolveOnListing({
      "PropertyInfo:1111": propertyRecord("A"),
      "PropertyInfo:2222": propertyRecord("B"),
    });
    assert.equal(payload, null, "precondition: this state must not resolve");
    assert.equal(windowObj.__vdpBridgeData, null, "payload should be null");
    assert.equal(windowObj.__vdpBridgeRan, true, "run flag must still be true");
  });

  test("__vdpBridgeRan is also set on a successful resolution", () => {
    const { windowObj } = resolveOnListing({ "PropertyInfo:2488800": propertyRecord("OK") });
    assert.equal(windowObj.__vdpBridgeRan, true);
    assert.ok(windowObj.__vdpBridgeData);
  });
});
