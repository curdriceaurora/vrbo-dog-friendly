// test/search-apollo-fast-path.test.js
// 8.1.1 Search-page Apollo fast path.
//
// The page-world bridge (page-bridge.js) reads window.__APOLLO_STATE__ on
// the search results page, which carries one PropertyInfo:<id> record per
// result card. When a requested property's record exists, the content
// script can badge the card without issuing any listing-page request.
//
// Covered here:
//   1. A synthetic search-page Apollo state resolves TWO property IDs
//      without any fetch.
//   2. An unrelated or empty Apollo state causes exactly one normal
//      queued fetch.
//   3. One property's graph cannot populate another property's badge.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const { createSearchFetchQueue, resolveSearchApolloRecord, hasConcretePolicy } = require("../search-fetcher.js");

const BRIDGE_SOURCE = fs.readFileSync(path.join(__dirname, "..", "page-bridge.js"), "utf8");

// Load page-bridge.js into a sandboxed browser-like environment. Events
// dispatched on the mocked window fire synchronously (mirroring how
// CustomEvents cross the isolated/MAIN world boundary in Chrome), so the
// request/response exchange can be asserted in a single tick.
function loadBridge(apolloState) {
  const listeners = new Map();
  const windowObj = {
    __APOLLO_STATE__: apolloState,
    location: {
      pathname: "/Hotel-Search?destination=Miami",
      href: "https://www.vrbo.com/Hotel-Search?destination=Miami",
    },
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

  function request(propertyIds, requestId = 1) {
    let response = null;
    const onData = (e) => {
      response = e.detail;
    };
    windowObj.addEventListener("vdp-search-apollo-data", onData);
    const req = new MockCustomEvent("vdp-search-apollo-request", { detail: { propertyIds, requestId } });
    windowObj.dispatchEvent(req);
    windowObj.removeEventListener("vdp-search-apollo-data", onData);
    return response;
  }

  return { window: windowObj, request };
}

function loadBridgeWithTwoProperties() {
  return loadBridge({
    "PropertyInfo:111": { rules: { __ref: "RulesBlock:111" } },
    "RulesBlock:111": { ruleList: [{ __ref: "RuleItem:111" }] },
    "RuleItem:111": {
      header: { text: "Pets" },
      value: "Dogs welcome, maximum 2 dogs under 50 lbs. $150 pet fee applies.",
    },
    "PropertyInfo:222": { rules: { __ref: "RulesBlock:222" } },
    "RulesBlock:222": { ruleList: [{ __ref: "RuleItem:222" }] },
    "RuleItem:222": {
      header: { text: "Pets" },
      value: "No pets allowed.",
    },
  });
}

test("8.1.1 synthetic search-page Apollo state resolves two property IDs without any fetch", async (t) => {
  const bridge = loadBridgeWithTwoProperties();

  let fetchCount = 0;
  const queue = createSearchFetchQueue({
    fetchFn: async () => {
      fetchCount++;
      throw new Error("fast path must not issue a listing fetch");
    },
  });

  const payload = bridge.request(["111", "222"], 7);
  assert.equal(payload.ok, true);
  assert.equal(payload.requestId, 7);
  assert.ok(payload.results["111"], "PropertyInfo:111 should resolve from page state");
  assert.ok(payload.results["222"], "PropertyInfo:222 should resolve from page state");

  const p111 = resolveSearchApolloRecord(payload.results["111"], "111");
  const p222 = resolveSearchApolloRecord(payload.results["222"], "222");
  assert.ok(hasConcretePolicy(p111), "111 must produce a concrete canonical policy");
  assert.ok(hasConcretePolicy(p222), "222 must produce a concrete canonical policy");
  assert.equal(p111.petsAllowed, true);
  assert.equal(p111.maxDogs, 2);
  assert.equal(p222.petsAllowed, false);

  // Content-script fast-path behavior: seed the cache from the page-state
  // policy, then enqueue. A cache hit means subscribers are notified and
  // NO listing fetch is issued for either property.
  queue.setCached("111", { status: "ok", propertyId: "111", policy: p111, ts: Date.now(), _source: "search-page-state" });
  queue.setCached("222", { status: "ok", propertyId: "222", policy: p222, ts: Date.now(), _source: "search-page-state" });
  queue.enqueue("111", "https://www.vrbo.com/111", "normal");
  queue.enqueue("222", "https://www.vrbo.com/222", "normal");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(fetchCount, 0, "Two properties resolved from search-page state must not fetch");
  queue.dispose();
});

test("8.1.1 unrelated or empty Apollo state causes exactly one normal queued fetch", async (t) => {
  // Unrelated state: no PropertyInfo:111 record, only foreign keys.
  const bridge = loadBridge({
    "SomeOtherKey:1": { value: "unrelated" },
    "PropertyInfo:333": { name: "A different property nobody requested" },
  });

  let fetchCount = 0;
  const queue = createSearchFetchQueue({
    fetchFn: async () => {
      fetchCount++;
      return { ok: true, status: 200, text: async () => "<section>Pets welcome</section>" };
    },
    maxConcurrent: 1,
    minDelayMs: 5,
  });
  queue.subscribe("111", () => {});

  const payload = bridge.request(["111"]);
  assert.equal(payload.results["111"], undefined, "Unrelated state must not resolve the requested property");

  // The content-script fast path would return null here (no record, no
  // concrete policy), so it falls through to a single normal enqueue.
  queue.enqueue("111", "https://www.vrbo.com/111", "normal");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(fetchCount, 1, "Exactly one normal queued fetch should run when page state is unusable");
  queue.dispose();

  // Empty state behaves the same way.
  const emptyBridge = loadBridge(null);
  const emptyPayload = emptyBridge.request(["111", "222"], 3);
  assert.equal(emptyPayload.ok, true);
  assert.equal(Object.keys(emptyPayload.results).length, 0, "Empty Apollo state is a normal empty result, not an error");
});

test("8.1.1 one property's graph cannot populate another property's badge", () => {
  // Only 111 has a graph in this state; 222 is requested but absent.
  const bridge = loadBridge({
    "PropertyInfo:111": { rules: { __ref: "RulesBlock:111" } },
    "RulesBlock:111": { ruleList: [{ __ref: "RuleItem:111" }] },
    "RuleItem:111": {
      header: { text: "Pets" },
      value: "Dogs welcome, maximum 2 dogs under 50 lbs. $150 pet fee applies.",
    },
  });

  // Requesting only 222 must not resolve 111 (and vice versa).
  const payload = bridge.request(["222"], 1);
  assert.equal(payload.results["222"], undefined, "222 has no graph in this state, so it must not resolve");
  assert.equal(payload.results["111"], undefined, "Asking for 222 must not leak 111's graph in");

  // With both requested, each record carries only its own items.
  const both = bridge.request(["111", "222"], 2);
  assert.ok(both.results["111"], "111's own graph resolves");
  assert.ok(both.results["111"].items.length > 0);
  assert.equal(both.results["222"], undefined, "222's badge cannot be populated by 111's graph");

  // Deduplicated items stay scoped to the requested property.
  assert.equal(both.results["111"].items.some((it) => it.text.includes("Dogs welcome")), true);
});

test("8.1.1 findApolloRoot only matches PropertyInfo: keys, not generic Property: entities", () => {
  // A "Property:111" entity with no matching "PropertyInfo:111" record. The
  // O(1) lookup added in perf/pipeline-hotspots-and-lru-cache must not widen
  // matching to accept this — Property: entities are a different Apollo
  // shape than PropertyInfo:, and resolving one would walk the wrong node.
  const bridge = loadBridge({
    "Property:111": { name: "A generic property entity, not the PropertyInfo shape" },
  });

  const payload = bridge.request(["111"], 1);
  assert.equal(payload.results["111"], undefined, "a bare Property: key must not resolve the fast path");
});

test("8.1.1 resolveSearchApolloRecord returns null for records with no concrete policy", () => {
  assert.equal(resolveSearchApolloRecord(null, "x"), null);
  assert.equal(resolveSearchApolloRecord({ propertyId: "x", items: [] }, "x"), null);
  // Non-pet text gets filtered by the corpus builder, yielding no policy.
  const unrelated = {
    propertyId: "x",
    items: [{ header: "House Rules", section: "House Rules", text: "No smoking inside." }],
  };
  assert.equal(resolveSearchApolloRecord(unrelated, "x"), null);
});