// test/search-ui.test.js
// Unit tests for search-fetcher AbortController, request timeouts, and cancellation.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSearchFetchQueue, parseListingHtml } = require("../src/shared/search-fetcher.js");

test("search-fetcher request lifecycle & cancellation", async (t) => {
  await t.test("aborts active fetch requests on queue.dispose()", async () => {
    let wasAborted = false;

    const mockFetch = (url, options) => {
      return new Promise((resolve, reject) => {
        if (options?.signal) {
          options.signal.addEventListener("abort", () => {
            wasAborted = true;
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    };

    const queue = createSearchFetchQueue({
      fetchFn: mockFetch,
      maxConcurrent: 1,
      minDelayMs: 10,
    });

    queue.enqueue("prop_abort_test", "https://www.vrbo.com/abort_test");
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(queue.getActiveCount(), 1, "Request should be active");
    queue.dispose();

    await new Promise((r) => setTimeout(r, 30));
    assert.equal(wasAborted, true, "Active request signal should have aborted");
    assert.equal(queue.getActiveCount(), 0, "Active count should be 0 after dispose");
  });

  await t.test("timeout emits exactly one terminal status: timeout notification, frees slot, never retries, and never writes to storage", async () => {
    let wasAborted = false;
    let fetchAttempts = 0;
    const notifications = [];
    const storageWrites = [];

    const mockStorage = {
      get(keys, cb) { cb({}); },
      set(obj, cb) { storageWrites.push(obj); cb && cb(); },
      remove(keys, cb) { cb && cb(); },
    };

    const mockFetch = (url, options) => {
      fetchAttempts++;
      return new Promise((resolve, reject) => {
        if (options?.signal) {
          options.signal.addEventListener("abort", () => {
            wasAborted = true;
            const err = new Error("Timeout aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    };

    const queue = createSearchFetchQueue({
      fetchFn: mockFetch,
      storage: mockStorage,
      maxConcurrent: 1,
      minDelayMs: 10,
      requestTimeoutMs: 40, // 40ms timeout
    });

    queue.subscribe("prop_timeout", (res) => {
      notifications.push(res);
    });

    queue.enqueue("prop_timeout", "https://www.vrbo.com/timeout");
    await new Promise((r) => setTimeout(r, 120));

    assert.equal(wasAborted, true, "Stalled request should abort on timeout");
    assert.equal(queue.getActiveCount(), 0, "Slot should be freed after timeout");
    assert.equal(fetchAttempts, 1, "Timed out request must never automatically retry");
    assert.equal(notifications.length, 1, "Must emit exactly one notification");
    assert.deepEqual(notifications[0], { status: "timeout", propertyId: "prop_timeout" });
    assert.equal(storageWrites.length, 0, "Timeout must never write to persistent storage");
    queue.dispose();
  });

  await t.test("generic pet filter copy produces unknown, never ok", () => {
    const htmlWithGenericCopy = `
      <html>
        <body>
          <div class="search-widget">
            <input type="checkbox" name="pets">
            <label>I am traveling with pets If checked, only properties that allow pets will be shown</label>
          </div>
        </body>
      </html>
    `;
    const parsed = parseListingHtml(htmlWithGenericCopy, "prop_generic");
    assert.equal(parsed, null, "Generic search filter copy should produce null/no policy");
  });

  await t.test("valid property policy produces and caches ok", async () => {
    const storageWrites = [];
    const mockStorage = {
      get(keys, cb) { cb({}); },
      set(obj, cb) { storageWrites.push(obj); cb && cb(); },
      remove(keys, cb) { cb && cb(); },
    };

    const mockFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => "<section>House Rules: Pets welcome! Maximum of 2 dogs allowed, $50 fee.</section>",
    });

    const queue = createSearchFetchQueue({
      fetchFn: mockFetch,
      storage: mockStorage,
      maxConcurrent: 1,
      minDelayMs: 5,
    });

    const notifications = [];
    queue.subscribe("prop_valid", (res) => notifications.push(res));
    queue.enqueue("prop_valid", "https://www.vrbo.com/valid");

    await new Promise((r) => setTimeout(r, 40));

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].status, "ok");
    assert.equal(notifications[0].policy.petsAllowed, true);
    assert.equal(notifications[0].policy.maxDogs, 2);
    assert.equal(storageWrites.length, 1, "Valid policy must be cached to storage");
    queue.dispose();
  });

  await t.test("pre-registration-only policies produce and cache ok", async () => {
    const storageWrites = [];
    const mockStorage = {
      get(keys, cb) { cb({}); },
      set(obj, cb) { storageWrites.push(obj); cb && cb(); },
      remove(keys, cb) { cb && cb(); },
    };

    const mockFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => "<section>House Rules: Prior approval is required for pets.</section>",
    });

    const queue = createSearchFetchQueue({
      fetchFn: mockFetch,
      storage: mockStorage,
      maxConcurrent: 1,
      minDelayMs: 5,
    });

    const notifications = [];
    queue.subscribe("prop_prereg", (res) => notifications.push(res));
    queue.enqueue("prop_prereg", "https://www.vrbo.com/prereg");

    await new Promise((r) => setTimeout(r, 40));

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].status, "ok");
    assert.equal(notifications[0].policy.approvalRequired, true);
    assert.equal(storageWrites.length, 1, "Pre-reg policy must be cached");
    queue.dispose();
  });

  await t.test("canonical policy model normalizes weights, fees, deposits, and schemaVersion 1", () => {
    const extract = require("../src/shared/extract.js");
    const sampleRawPolicy = {
      found: true,
      petsAllowed: true,
      maxDogs: 2,
      maxDogsAlternates: [],
      weightPerDog: "50 lbs",
      weightAlternates: [{ value: "75 lbs", snippet: "Dogs up to 75 lbs", source: "About" }],
      fee: "$150 per stay",
      feeAlternates: [],
      deposit: "$200",
      preReg: true,
      otherNotes: [],
    };

    const canonical = extract.normalizePolicy(sampleRawPolicy, "3173015", "search-response");

    assert.equal(canonical.propertyId, "3173015");
    assert.equal(canonical.petsAllowed, true);
    assert.equal(canonical.maxDogs, 2);
    assert.deepEqual(canonical.weightLimit, { value: 50, unit: "lb", pounds: 50 });
    assert.deepEqual(canonical.fee, { amount: 150, currency: "USD", period: "stay" });
    assert.deepEqual(canonical.deposit, { amount: 200, currency: "USD" });
    assert.equal(canonical.approvalRequired, true);
    assert.deepEqual(canonical.contradictions, { maxDogs: false, weightLimit: true, fee: false });
    assert.equal(canonical.confidence, "high");
    assert.equal(canonical.source, "search-response");
    assert.equal(canonical.schemaVersion, 1);

    // Test badge derivation: enforces 4-item budget (Status + max 3 secondary constraints)
    const badge = extract.deriveSearchBadge(canonical);
    assert.equal(badge.statusKey, "allowed");
    assert.equal(badge.text, "Max 2 dogs allowed · 50 lbs · $150/stay");
  });

  await t.test("future filtering readiness: conservative missing-value semantics", () => {
    const extract = require("../src/shared/extract.js");
    const partialRaw = {
      found: true,
      petsAllowed: null,
      maxDogs: null,
      weightPerDog: null,
      fee: null,
      deposit: null,
      preReg: null,
      otherNotes: [],
    };

    const canonical = extract.normalizePolicy(partialRaw, "empty_prop", "search-response");

    // Strictly null for missing fields
    assert.equal(canonical.petsAllowed, null);
    assert.equal(canonical.maxDogs, null);
    assert.equal(canonical.weightLimit, null);
    assert.equal(canonical.fee, null);
    assert.equal(canonical.deposit, null);
    assert.equal(canonical.approvalRequired, null);

    // Conservative filtering assertion: null maxDogs does NOT match >= 2 dogs
    const filterTwoDogs = (p) => typeof p.maxDogs === "number" && p.maxDogs >= 2;
    assert.equal(filterTwoDogs(canonical), false);

    // Conservative filtering assertion: null weightLimit does NOT match <= 50 lbs
    const filterWeight50 = (p) => p.weightLimit && typeof p.weightLimit.pounds === "number" && p.weightLimit.pounds >= 50;
    assert.equal(filterWeight50(canonical), null);
  });
});

// ---------------------------------------------------------------------------
// Card orchestration harness (I3 / I4b / I7 / I8b / I9).
//
// content.js is a browser-coupled IIFE, so driving its card orchestration under
// `node --test` needs a platform stub: a minimal DOM, an IntersectionObserver,
// a MutationObserver, chrome.storage, and a recording setTimeout. None of that
// existed under test/ before this suite — the IntersectionObserver mock in
// particular is built here, not inherited.
//
// No test in this file may reach the network: the real fetch is replaced with a
// throwing stub and every queue is constructed with an injected mock fetch.
// ---------------------------------------------------------------------------

const SEARCH_URL_A = "https://www.vrbo.com/Hotel-Search?destination=Tahoe";
const SEARCH_URL_B = "https://www.vrbo.com/Hotel-Search?destination=Tahoe&page=2";
const LISTING_URL = "https://www.vrbo.com/3000003";

const LISTING_HTML = "<section>House Rules: Pets welcome! Maximum of 2 dogs allowed, $50 fee.</section>";

// ---------- selector engine (flat selectors only: no combinators needed) ----------

function parseCompound(sel) {
  const tokens = [];
  const re = /\[[^\]]+\]|[.#]?[A-Za-z0-9_-]+|\*/g;
  let m;
  while ((m = re.exec(sel)) !== null) tokens.push(m[0]);
  return tokens;
}

function matchesToken(el, token) {
  if (token === "*") return true;
  if (token.startsWith("#")) return el.getAttribute("id") === token.slice(1);
  if (token.startsWith(".")) return el._classes.has(token.slice(1));
  if (token.startsWith("[")) {
    const body = token.slice(1, -1);
    const parsed = /^([A-Za-z0-9_-]+)(?:([*^$~|]?)=\s*["']?([^"'\]]*)["']?)?$/.exec(body);
    if (!parsed) return false;
    const [, name, op, rawValue] = parsed;
    const actual = el.getAttribute(name);
    if (actual === null) return false;
    if (rawValue === undefined) return true;
    if (op === "*") return actual.includes(rawValue);
    if (op === "^") return actual.startsWith(rawValue);
    if (op === "$") return actual.endsWith(rawValue);
    return actual === rawValue;
  }
  return el.tagName === token.toUpperCase();
}

function matchesSelector(el, selector) {
  return String(selector)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .some((compound) => parseCompound(compound).every((token) => matchesToken(el, token)));
}

function collectDescendants(node, out) {
  for (const child of node.childNodes) {
    out.push(child);
    collectDescendants(child, out);
  }
  return out;
}

// ---------- minimal element ----------

class MockNode {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this._attrs = new Map();
    this._classes = new Set();
    this._text = "";
    this._listeners = new Map();
    this.dataset = {};
    this.style = {};
    this.classList = {
      add: (...cls) => cls.forEach((c) => this._classes.add(c)),
      remove: (...cls) => cls.forEach((c) => this._classes.delete(c)),
      contains: (c) => this._classes.has(c),
      toggle: (c, on) => (on ? this._classes.add(c) : this._classes.delete(c)),
    };
  }

  get className() { return Array.from(this._classes).join(" "); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get id() { return this.getAttribute("id") || ""; }
  set id(v) { this.setAttribute("id", v); }
  get href() { return this.getAttribute("href"); }
  set href(v) { this.setAttribute("href", v); }
  set innerHTML(v) { this._text = String(v); this.childNodes.length = 0; }
  get innerHTML() { return this._text; }

  get textContent() {
    return this._text + this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes.length = 0;
    this._text = String(v);
  }

  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node === mockDocument.documentElement;
  }

  setAttribute(name, value) { this._attrs.set(name, String(value)); }
  getAttribute(name) { return this._attrs.has(name) ? this._attrs.get(name) : null; }
  removeAttribute(name) { this._attrs.delete(name); }
  hasAttribute(name) { return this._attrs.has(name); }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild(child) {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) this.childNodes.splice(idx, 1);
    child.parentNode = null;
    return child;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }

  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    return collectDescendants(this, []).filter((el) => matchesSelector(el, sel));
  }
  matches(sel) { return matchesSelector(this, sel); }
  closest(sel) {
    let node = this;
    while (node) {
      if (node.matches && node.matches(sel)) return node;
      node = node.parentNode;
    }
    return null;
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this._listeners.get(type)?.delete(fn); }
  dispatchEvent(evt) {
    for (const fn of this._listeners.get(evt?.type) || []) fn(evt);
    return true;
  }
  focus() {}
  getBoundingClientRect() { return { top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20 }; }
}

const mockDocument = {
  visibilityState: "visible",
  documentElement: new MockNode("html"),
  body: null,
  _listeners: new Map(),
  createElement: (tag) => new MockNode(tag),
  querySelector(sel) { return this.documentElement.querySelector(sel); },
  querySelectorAll(sel) { return this.documentElement.querySelectorAll(sel); },
  getElementById(id) { return this.documentElement.querySelector(`[id="${id}"]`); },
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  },
  removeEventListener(type, fn) { this._listeners.get(type)?.delete(fn); },
  dispatchEvent() { return true; },
  get activeElement() { return null; },
};
mockDocument.body = mockDocument.documentElement.appendChild(new MockNode("body"));

// ---------- observers ----------

const intersectionObservers = [];
class MockIntersectionObserver {
  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    this.observed = new Set();
    intersectionObservers.push(this);
  }
  observe(el) { this.observed.add(el); }
  unobserve(el) { this.observed.delete(el); }
  disconnect() { this.observed.clear(); }
  takeRecords() { return []; }
  // Test driver: deliver entries the way a browser would.
  fire(entries) {
    this.callback(entries.map(({ card, inView }) => ({ target: card, isIntersecting: inView })), this);
  }
}

const mutationObservers = [];
class MockMutationObserver {
  constructor(callback) {
    this.callback = callback;
    mutationObservers.push(this);
  }
  observe() {}
  disconnect() {}
  takeRecords() { return []; }
  fire(records) { this.callback(records, this); }
}

// ---------- timers ----------

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const liveTimers = new Set();
let capturedDelays = null;

function sleep(ms) { return new Promise((r) => realSetTimeout(r, ms)); }

function clearAllTimers() {
  for (const id of liveTimers) realClearTimeout(id);
  liveTimers.clear();
}

/** Collect every setTimeout delay scheduled during a synchronous call. */
function captureDelays(fn) {
  capturedDelays = [];
  try {
    fn();
    return capturedDelays;
  } finally {
    capturedDelays = null;
  }
}

// ---------- fetch / storage stubs ----------

const fetchLog = [];
const hangingIds = new Set();
const hangingResolvers = new Map();

function listingResponse(url) {
  return { ok: true, status: 200, url, text: async () => LISTING_HTML };
}

function mockFetch(url) {
  fetchLog.push(url);
  const propId = (/vrbo\.com\/(\d+)/.exec(String(url)) || [])[1];
  if (propId && hangingIds.has(propId)) {
    return new Promise((resolve) => {
      hangingResolvers.set(propId, () => resolve(listingResponse(url)));
    });
  }
  return Promise.resolve(listingResponse(url));
}

const storageData = new Map();
const mockChromeStorage = {
  get(keys, cb) {
    const out = {};
    if (keys === null || keys === undefined) {
      for (const [k, v] of storageData) out[k] = v;
    } else if (Array.isArray(keys)) {
      for (const k of keys) if (storageData.has(k)) out[k] = storageData.get(k);
    } else if (typeof keys === "string") {
      if (storageData.has(keys)) out[keys] = storageData.get(keys);
    } else {
      for (const k of Object.keys(keys)) out[k] = storageData.has(k) ? storageData.get(k) : keys[k];
    }
    cb && cb(out);
  },
  set(obj, cb) {
    for (const [k, v] of Object.entries(obj)) storageData.set(k, v);
    cb && cb();
  },
  remove(keys, cb) {
    for (const k of [].concat(keys)) storageData.delete(k);
    cb && cb();
  },
};

// ---------- queue spies ----------

const spies = { enqueue: [], remove: [], notify: [], unsubscribe: [] };
let queueOptions = {};

function resetSpies() {
  spies.enqueue.length = 0;
  spies.remove.length = 0;
  spies.notify.length = 0;
  spies.unsubscribe.length = 0;
}

// ---------- harness install ----------

let __test = null;

function installHarness() {
  if (__test) return __test;

  const realFetcher = require("../src/shared/search-fetcher.js");

  globalThis.document = mockDocument;
  globalThis.location = { href: SEARCH_URL_A };
  globalThis.window = {
    location: globalThis.location,
    innerWidth: 1280,
    innerHeight: 900,
    _listeners: new Map(),
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, new Set());
      this._listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { this._listeners.get(type)?.delete(fn); },
    dispatchEvent(evt) {
      for (const fn of this._listeners.get(evt?.type) || []) fn(evt);
      return true;
    },
  };
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init) { this.type = type; this.detail = init ? init.detail : undefined; }
  };
  globalThis.Event = class Event {
    constructor(type) { this.type = type; }
  };
  globalThis.IntersectionObserver = MockIntersectionObserver;
  globalThis.MutationObserver = MockMutationObserver;
  globalThis.chrome = {
    storage: {
      local: mockChromeStorage,
      onChanged: { addListener() {} },
    },
    runtime: { onMessage: { addListener() {} } },
  };

  // Nothing in this suite may reach the network.
  globalThis.fetch = () => { throw new Error("live fetch is blocked in unit tests"); };

  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (capturedDelays) capturedDelays.push(ms);
    const id = realSetTimeout(fn, ms, ...rest);
    liveTimers.add(id);
    return id;
  };
  globalThis.clearTimeout = (id) => { liveTimers.delete(id); realClearTimeout(id); };
  globalThis.requestAnimationFrame = (fn) => {
    const id = realSetTimeout(fn, 16);
    liveTimers.add(id);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    liveTimers.delete(id);
    realClearTimeout(id);
  };
  globalThis.performance = {
    now: () => Date.now(),
  };
  globalThis.setInterval = () => ({ mockInterval: true });
  globalThis.clearInterval = () => {};

  globalThis.VdpSiteRegistry = require("../src/shared/site-registry.js");
  globalThis.VDPExtract = require("../src/shared/extract.js");
  globalThis.VdpFormatters = require("../src/shared/formatters.js");
  globalThis.VdpSearchFetcher = {
    ...realFetcher,
    createSearchFetchQueue(options = {}) {
      const queue = realFetcher.createSearchFetchQueue({
        fetchFn: mockFetch,
        storage: mockChromeStorage,
        maxConcurrent: 1,
        minDelayMs: 5,
        autoMaintenance: false,
        ...queueOptions,
        ...options,
      });
      const { enqueue, remove, subscribe } = queue;
      queue.enqueue = (propId, url, priority) => {
        spies.enqueue.push({ propId, url, priority });
        return enqueue(propId, url, priority);
      };
      queue.remove = (propId) => {
        const result = remove(propId);
        spies.remove.push({ propId, result });
        return result;
      };
      queue.subscribe = (propId, cb) => {
        const wrapped = (data) => {
          spies.notify.push({ propId, data });
          return cb(data);
        };
        const unsub = subscribe(propId, wrapped);
        return () => {
          spies.unsubscribe.push(propId);
          return unsub();
        };
      };
      return queue;
    },
  };

  storageData.set("vrbow_enable_search_badging", true);
  __test = require("../src/content/content.js").__test;
  return __test;
}

// ---------- page helpers ----------

function freshSearchPage(options = {}) {
  if (__test) __test.cleanupSearchManager();
  clearAllTimers();
  for (const child of mockDocument.body.childNodes.slice()) child.remove();
  storageData.clear();
  storageData.set("vrbow_enable_search_badging", true);
  fetchLog.length = 0;
  hangingIds.clear();
  hangingResolvers.clear();
  resetSpies();
  queueOptions = options;
  globalThis.location.href = SEARCH_URL_A;
  __test.initSearchManager();
}

function makeCard(id, href) {
  const card = mockDocument.createElement("div");
  card.setAttribute("data-stid", "property-card");
  card.setAttribute("id", id);
  const content = mockDocument.createElement("div");
  content.classList.add("uitk-card-content");
  const anchor = mockDocument.createElement("a");
  anchor.setAttribute("href", href);
  content.appendChild(anchor);
  card.appendChild(content);
  mockDocument.body.appendChild(card);
  return card;
}

// #18: the layout no fixture covered. A price sub-element sits AHEAD of the
// content column in document order, which is what makes a selector-list
// querySelector resolve to the wrong box.
function makePriceFirstCard(id, href) {
  const card = mockDocument.createElement("div");
  card.setAttribute("data-stid", "property-card");
  card.setAttribute("id", id);
  const price = mockDocument.createElement("div");
  price.setAttribute("data-stid", "price-summary");
  card.appendChild(price);
  const content = mockDocument.createElement("div");
  content.classList.add("uitk-card-content");
  const anchor = mockDocument.createElement("a");
  anchor.setAttribute("href", href);
  content.appendChild(anchor);
  card.appendChild(content);
  mockDocument.body.appendChild(card);
  return card;
}

function recycleCard(card, href) {
  card.querySelector("a[href]").setAttribute("href", href);
}

function currentObserver() { return __test.getSearchCardObserver(); }

function fireIntersection(entries) { currentObserver().fire(entries); }

function fireMutation() {
  // Must be page DOM, not one of Vrbow's own nodes: the observer deliberately
  // ignores mutations that only touch its badge/tooltip/panel.
  const target = mockDocument.body.querySelector('[data-stid="property-card"]') || mockDocument.body;
  mutationObservers[mutationObservers.length - 1].fire([{ target }]);
}

function badgeOf(card) { return card.querySelector(".vdp-search-badge"); }

const listingUrlFor = (propId) => `https://www.vrbo.com/${propId}?chkin=2026-09-01`;

test("search card orchestration: recycle gate, dwell jitter, scan throttle, and nav prune", async (t) => {
  installHarness();

  t.after(() => {
    __test.cleanupSearchManager();
    clearAllTimers();
  });

  await t.test("I3: an off-screen recycle does not enqueue, an in-view recycle does", async () => {
    freshSearchPage();
    const card = makeCard("card-1", listingUrlFor("1000001"));
    __test.scanSearchCards();
    assert.equal(card.getAttribute("data-vdp-prop-id"), "1000001");
    assert.equal(spies.enqueue.length, 0, "first bind must not enqueue on its own");

    // Card is off-screen.
    fireIntersection([{ card, inView: false }]);
    const enqueuedBefore = __test.getSearchStats().enqueued;

    recycleCard(card, listingUrlFor("2000002"));
    __test.scanSearchCards();

    assert.equal(card.getAttribute("data-vdp-prop-id"), "2000002", "re-binding still happens off-screen");
    assert.equal(spies.enqueue.length, 0, "off-screen recycle must not enqueue");
    assert.equal(__test.getSearchStats().enqueued, enqueuedBefore, "no enqueue for an off-screen recycle");

    // Same card, now on-screen.
    fireIntersection([{ card, inView: true }]);
    recycleCard(card, listingUrlFor("3000003"));
    __test.scanSearchCards();

    assert.equal(card.getAttribute("data-vdp-prop-id"), "3000003");
    assert.deepEqual(
      spies.enqueue.map((e) => e.propId),
      ["3000003"],
      "in-view recycle enqueues exactly the new property"
    );
    assert.equal(__test.getSearchStats().enqueued, enqueuedBefore + 1);
  });

  await t.test("I4b: dwell timers are jittered one-sided, never below the 400 ms floor", async () => {
    freshSearchPage();
    const cards = [];
    for (let i = 0; i < 24; i++) {
      cards.push(makeCard(`jitter-${i}`, listingUrlFor(`400000${i}`)));
    }
    __test.scanSearchCards();

    const delays = captureDelays(() => {
      fireIntersection(cards.map((card) => ({ card, inView: true })));
    });

    assert.equal(delays.length, cards.length, "one dwell timer per entering card");
    for (const d of delays) {
      assert.ok(d >= 400, `dwell ${d} must never dip below the 400 ms floor`);
      assert.ok(d < 600, `dwell ${d} must stay inside the 200 ms jitter band`);
    }
    assert.ok(new Set(delays).size > 1, "dwell timers must not fire in unison");
  });

  await t.test("I9: mutation-driven scans run on a leading-edge throttle", async () => {
    freshSearchPage();
    makeCard("card-1", listingUrlFor("1000001"));

    const before = __test.getSearchStats().scans;
    for (let i = 0; i < 6; i++) fireMutation();
    assert.equal(
      __test.getSearchStats().scans,
      before + 1,
      "a burst of 6 mutations collapses to a single leading-edge scan"
    );

    await sleep(__test.SEARCH_SCAN_THROTTLE_MS + 80);
    assert.equal(
      __test.getSearchStats().scans,
      before + 2,
      "the burst leaves exactly one trailing scan behind"
    );

    for (let i = 0; i < 6; i++) fireMutation();
    assert.ok(
      __test.getSearchStats().scans <= before + 3,
      "a second burst is throttled as well"
    );
  });

  await t.test("I8b: leaving the viewport prunes the queued item", async () => {
    // minDelayMs is long enough that the second item stays queued for the whole test.
    freshSearchPage({ minDelayMs: 5000 });
    hangingIds.add("1000001");

    // Occupy the single concurrency slot with a request that never settles, so
    // the second card's item is guaranteed to still be *queued*, not in flight.
    const cardA = makeCard("card-a", listingUrlFor("1000001"));
    __test.scanSearchCards();
    fireIntersection([{ card: cardA, inView: true }]);
    await sleep(700); // dwell floor + jitter
    assert.equal(__test.getSearchQueue().getActiveCount(), 1, "A holds the only slot");

    const cardB = makeCard("card-b", listingUrlFor("2000002"));
    __test.scanSearchCards();
    fireIntersection([{ card: cardB, inView: true }]);
    await sleep(700);

    assert.deepEqual(spies.enqueue.map((e) => e.propId).sort(), ["1000001", "2000002"]);
    assert.equal(__test.getSearchQueue().getQueueLength(), 1, "B waits behind the in-flight A");

    const prunedBefore = __test.getSearchStats().prunedOffscreen;
    fireIntersection([{ card: cardB, inView: false }]);

    assert.deepEqual(
      spies.remove.filter((r) => r.propId === "2000002"),
      [{ propId: "2000002", result: true }],
      "the queued item is withdrawn when its card leaves the viewport"
    );
    assert.equal(__test.getSearchQueue().getQueueLength(), 0, "queue drained of the off-screen item");
    assert.equal(__test.getSearchStats().prunedOffscreen, prunedBefore + 1);

    // The in-flight request is deliberately NOT cancellable this way.
    fireIntersection([{ card: cardA, inView: false }]);
    assert.equal(
      spies.remove.find((r) => r.propId === "1000001")?.result,
      false,
      "an in-flight id is not removable"
    );
    assert.equal(
      __test.getSearchStats().prunedOffscreen,
      prunedBefore + 1,
      "an in-flight id must not be counted as pruned"
    );
  });

  await t.test("I7: search -> search keeps the session budget and prunes ids gone from the DOM", async () => {
    freshSearchPage({ minDelayMs: 5000 });
    hangingIds.add("1000001");

    const cardA = makeCard("card-a", listingUrlFor("1000001"));
    const cardB = makeCard("card-b", listingUrlFor("2000002"));
    __test.scanSearchCards();
    fireIntersection([{ card: cardA, inView: true }, { card: cardB, inView: true }]);
    await sleep(700);

    const queueBefore = __test.getSearchQueue();
    const sessionBefore = queueBefore.getSessionCount();
    assert.ok(sessionBefore >= 1, "at least one request must have been spent for the budget check to mean anything");
    assert.ok(__test.getTrackedSearchCards().has("1000001"));

    // SPA search -> search: the previous result set is torn out of the DOM.
    cardA.remove();
    globalThis.location.href = SEARCH_URL_B;
    __test.onUrlMaybeChanged();

    assert.equal(__test.getSearchQueue(), queueBefore, "the queue object is reused across search -> search");
    assert.equal(
      __test.getSearchQueue().getSessionCount(),
      sessionBefore,
      "sessionRequestsCount must survive search -> search (clearQueue would have zeroed it)"
    );
    assert.equal(__test.getTrackedSearchCards().has("1000001"), false, "stale id is untracked");
    assert.ok(__test.getTrackedSearchCards().has("2000002"), "live card keeps its tracking");
    assert.ok(__test.getSearchStats().prunedStale >= 1, "prune counter records the stale id");
    assert.ok(
      spies.remove.some((r) => r.propId === "1000001"),
      "prune goes through remove(), not clearQueue()"
    );
  });

  await t.test("prune closes the notify path: an in-flight response cannot repaint a pruned card", async () => {
    freshSearchPage({ minDelayMs: 5 });
    hangingIds.add("1000001");

    const card = makeCard("card-a", listingUrlFor("1000001"));
    __test.scanSearchCards();
    const badge = badgeOf(card);
    fireIntersection([{ card, inView: true }]);
    await sleep(700);

    assert.equal(__test.getSearchQueue().getActiveCount(), 1, "request must be in flight for this test to mean anything");
    assert.equal(badge.dataset.vdpStatus, "loading");

    card.remove();
    const pruned = __test.pruneStaleSearchCards();
    assert.equal(pruned, 1);
    assert.ok(spies.unsubscribe.includes("1000001"), "prune tears down the card subscription");
    assert.equal(
      spies.remove.find((r) => r.propId === "1000001")?.result,
      false,
      "remove() cannot drop an in-flight item — the subscription teardown is what protects the badge"
    );

    const notifiesBefore = spies.notify.length;
    hangingResolvers.get("1000001")();
    await sleep(150);

    assert.equal(
      spies.notify.filter((n) => n.propId === "1000001").length,
      0,
      "the completed in-flight request must not reach the pruned card's subscriber"
    );
    assert.equal(spies.notify.length, notifiesBefore);
    assert.equal(badge.dataset.vdpStatus, "loading", "badge was never repainted by the stale response");
  });

  await t.test("a pruned card that returns to the DOM re-subscribes without issuing a new request", async () => {
    freshSearchPage();
    const card = makeCard("card-a", listingUrlFor("1000001"));
    __test.scanSearchCards();
    fireIntersection([{ card, inView: true }]);
    await sleep(700);

    const enqueuesBefore = spies.enqueue.length;
    assert.equal(enqueuesBefore, 1);

    // Virtualized list detaches the node, prune tears its subscription down...
    card.remove();
    assert.equal(__test.pruneStaleSearchCards(), 1);
    assert.equal(card._vdpUnsub, null, "prune released the subscription");

    // ...and then the same node, still showing the same property, comes back.
    mockDocument.body.appendChild(card);
    __test.scanSearchCards();

    assert.equal(typeof card._vdpUnsub, "function", "a returning card must re-subscribe");
    assert.ok(__test.getTrackedSearchCards().has("1000001"), "and be tracked again");
    assert.equal(spies.enqueue.length, enqueuesBefore, "re-attaching must not re-request the property");
  });

  await t.test("search -> listing still disposes the queue outright", async () => {
    freshSearchPage();
    makeCard("card-a", listingUrlFor("1000001"));
    __test.scanSearchCards();
    assert.ok(__test.getSearchQueue(), "queue exists on a search page");

    globalThis.location.href = LISTING_URL;
    __test.onUrlMaybeChanged();

    assert.equal(__test.getSearchQueue(), null, "search -> listing disposes, unchanged from before");
    assert.equal(__test.getTrackedSearchCards().size, 0);
    assert.equal(mockDocument.querySelectorAll(".vdp-search-badge").length, 0);

    // The listing branch schedules a full page rescan; nothing here needs it.
    clearAllTimers();
    globalThis.location.href = SEARCH_URL_A;
  });

  await t.test("instrumentation counters track dispatch and each prune path, and reset with the queue", async () => {
    freshSearchPage({ minDelayMs: 5000 });

    const zero = __test.getSearchStats();
    assert.equal(zero.enqueued, 0);
    assert.equal(zero.prunedOffscreen, 0);
    assert.equal(zero.prunedRecycled, 0);
    assert.equal(zero.prunedStale, 0);

    hangingIds.add("1000001");
    const cardA = makeCard("card-a", listingUrlFor("1000001"));
    __test.scanSearchCards();
    fireIntersection([{ card: cardA, inView: true }]);
    await sleep(700);
    assert.equal(__test.getSearchQueue().getActiveCount(), 1, "A occupies the only slot");

    // B and C therefore stay queued, whichever order their jittered dwells fire in.
    const cardB = makeCard("card-b", listingUrlFor("2000002"));
    const cardC = makeCard("card-c", listingUrlFor("3000003"));
    __test.scanSearchCards();
    fireIntersection([
      { card: cardB, inView: true },
      { card: cardC, inView: true },
    ]);
    await sleep(700);

    assert.equal(__test.getSearchStats().enqueued, 3, "one enqueue per dwell-gated card");
    assert.ok(__test.getSearchStats().maxQueueDepth >= 1, "queue depth is sampled over time");
    assert.ok(__test.getSearchStats().depthSamples.length >= 3);
    assert.ok(
      __test.getSearchStats().depthSamples.every((s) => typeof s.t === "number" && typeof s.depth === "number"),
      "depth samples are plain in-memory records"
    );

    // Off-screen prune path.
    fireIntersection([{ card: cardC, inView: false }]);
    assert.equal(__test.getSearchStats().prunedOffscreen, 1);

    // Recycle prune path: cardB is re-pointed at a new property while queued.
    recycleCard(cardB, listingUrlFor("5000005"));
    __test.scanSearchCards();
    assert.equal(__test.getSearchStats().prunedRecycled, 1, "the property a recycled node dropped is withdrawn");

    // Stale prune path.
    cardB.remove();
    assert.equal(__test.pruneStaleSearchCards(), 1);
    assert.equal(__test.getSearchStats().prunedStale, 1);

    // Nothing here is persisted: the counters live only in memory.
    assert.equal(
      Array.from(storageData.keys()).some((k) => /stat|count|metric|analytic/i.test(k)),
      false,
      "instrumentation must never be written to chrome.storage"
    );

    __test.cleanupSearchManager();
    const afterReset = __test.getSearchStats();
    assert.deepEqual(
      {
        scans: afterReset.scans,
        enqueued: afterReset.enqueued,
        prunedOffscreen: afterReset.prunedOffscreen,
        prunedRecycled: afterReset.prunedRecycled,
        prunedStale: afterReset.prunedStale,
        maxQueueDepth: afterReset.maxQueueDepth,
        depthSamples: afterReset.depthSamples.length,
      },
      { scans: 0, enqueued: 0, prunedOffscreen: 0, prunedRecycled: 0, prunedStale: 0, maxQueueDepth: 0, depthSamples: 0 },
      "counters are queue-scoped and reset with it"
    );
  });

  // #23 gates on measured queue pressure, so the counters that answer it have to
  // mean what they say. These are the three ways the pre-existing set could not.
  // #18: querySelector with a selector list returns the first match in DOCUMENT
  // ORDER, not the first selector that matches. A card whose price element
  // precedes its content column therefore mounts the badge in the narrow price
  // box, which only stayed invisible while the badge was inline-flex.
  await t.test("#18: the badge mounts in the content column even when a price element precedes it", async () => {
    freshSearchPage({ minDelayMs: 5000 });

    const card = makePriceFirstCard("card-price-first", listingUrlFor("1000001"));
    __test.scanSearchCards();

    const badge = badgeOf(card);
    assert.ok(badge, "the card is bound and badged");

    const price = card.querySelector('[data-stid="price-summary"]');
    const content = card.querySelector(".uitk-card-content");
    assert.equal(
      price.querySelector(".vdp-search-badge"),
      null,
      "the badge must not mount inside the price sub-element"
    );
    assert.ok(
      content.querySelector(".vdp-search-badge"),
      "the badge belongs to the content column, whose width it is meant to match"
    );
  });

  // #18: width: 100% on the badge only behaves in a block parent; in a flex-row
  // parent it overflows. The slot decouples the badge from whatever the host
  // container happens to be.
  await t.test("#18: the badge sits in a block-level slot, not directly in the host container", async () => {
    freshSearchPage({ minDelayMs: 5000 });

    const card = makePriceFirstCard("card-slotted", listingUrlFor("1000001"));
    __test.scanSearchCards();

    const badge = badgeOf(card);
    const slot = badge.parentNode;
    assert.ok(
      slot.classList.contains("vdp-badge-slot"),
      "the badge's direct parent is the slot the extension owns"
    );
    assert.equal(
      slot.parentNode,
      card.querySelector(".uitk-card-content"),
      "and the slot is what mounts into the resolved container"
    );

    // The extra level must stay invisible to every descendant lookup in the
    // orchestration paths, which is how recycling finds an existing badge.
    assert.equal(card.querySelector(".vdp-search-badge"), badge);
  });

  // #18: the elevation that wins hit-testing over .uitk-card-link is applied in
  // two places — inline by content.js and by a rule in content.css. Introducing
  // the slot moves what `:has(> .vdp-search-badge)` matches, so the two can
  // silently drift onto different nodes. At full width that failure spans the
  // whole card instead of a small pill.
  await t.test("#18: the CSS elevation rule and the inline elevation target the same node", async () => {
    freshSearchPage({ minDelayMs: 5000 });

    const card = makePriceFirstCard("card-elevated", listingUrlFor("1000001"));
    __test.scanSearchCards();

    const badge = badgeOf(card);
    const slot = badge.parentNode;
    const host = slot.parentNode;

    assert.equal(host.style.zIndex, "2", "content.js elevates the resolved container");
    assert.equal(host.style.position, "relative", "and positions it so the z-index applies");

    // The stylesheet must elevate that same container. `:has(> .vdp-search-badge)`
    // now resolves to the slot, one level too low, so the rule has to select on
    // the slot instead.
    // Comments stripped: this asserts on live rules, and the rule below is
    // explained by a comment that necessarily names the old selector.
    const css = require("node:fs")
      .readFileSync(require("node:path").join(__dirname, "..", "src", "content", "content.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(
      css,
      /\[data-vdp-prop-id\]\s+:has\(>\s*\.vdp-badge-slot\)/,
      "the elevation rule selects the slot's parent, matching the inline style"
    );
    assert.doesNotMatch(
      css,
      /:has\(>\s*\.vdp-search-badge\)/,
      "the pre-slot selector would elevate the slot rather than the container"
    );
  });

  await t.test("#23 gate: enqueue calls, network requests, and staged depth are distinguishable", async () => {
    freshSearchPage({ minDelayMs: 5000 });
    hangingIds.add("1000001");

    const cardA = makeCard("card-a", listingUrlFor("1000001"));
    __test.scanSearchCards();
    fireIntersection([{ card: cardA, inView: true }]);
    await sleep(700);

    const stats = __test.getSearchStats();
    assert.equal(stats.enqueued, 1, "one enqueue call");
    assert.equal(
      stats.networkRequests,
      __test.getSearchQueue().getSessionCount(),
      "networkRequests reads through to the queue's own session counter"
    );

    // An enqueue that resolves from cache issues no fetch, so the two counters
    // must diverge. Without this, #23's pruned-vs-dispatched ratio uses an
    // inflated denominator and understates how well I8b is working.
    const enqueuedBefore = stats.enqueued;
    const networkBefore = stats.networkRequests;
    await __test.getSearchQueue().setCached("7000007", {
      status: "ok",
      propertyId: "7000007",
      policy: { petsAllowed: true, maxDogs: 2, schemaVersion: 1 },
      ts: Date.now(),
    });
    const cardCached = makeCard("card-cached", listingUrlFor("7000007"));
    __test.scanSearchCards();
    fireIntersection([{ card: cardCached, inView: true }]);
    await sleep(700);

    const after = __test.getSearchStats();
    assert.equal(after.enqueued, enqueuedBefore + 1, "the cache hit still counts as an enqueue call");
    assert.equal(after.networkRequests, networkBefore, "but it puts no request on the wire");
  });

  await t.test("#23 gate: depth samples include items still staging behind getCached()", async () => {
    // enqueue() stages synchronously but pushes to the queue array only after its
    // getCached() promise settles, so an item sits in the staging map for at least
    // a microtask. getQueueLength() alone cannot see it during that window.
    freshSearchPage({ minDelayMs: 5000 });
    hangingIds.add("1000001");

    const cardA = makeCard("card-a", listingUrlFor("1000001"));
    __test.scanSearchCards();
    fireIntersection([{ card: cardA, inView: true }]);
    await sleep(700);

    const queue = __test.getSearchQueue();
    assert.equal(typeof queue.getPendingCount, "function", "the queue exposes its staged count");

    const cardB = makeCard("card-b", listingUrlFor("2000002"));
    __test.scanSearchCards();
    fireIntersection([{ card: cardB, inView: true }]);
    await sleep(700);

    const staged = __test.getSearchStats().depthSamples.filter((s) => s.staged > 0);
    assert.ok(
      staged.length >= 1,
      "at least one sample must have caught an item mid-staging, or the undercount is back"
    );
    for (const s of __test.getSearchStats().depthSamples) {
      assert.ok(s.depth >= s.staged, `sample depth ${s.depth} must include its ${s.staged} staged items`);
    }
  });

  await t.test("Issue #31 sub-fix 1: a fast-path rich/definitive hit skips the storage write but stays servable", async () => {
    freshSearchPage();
    const propId = "9990001";
    // Block the follow-up full listing fetch that the fast-path branch still
    // schedules (by design, to let richer data supersede it later) so its
    // *own* setCached({persist:true}) never fires and muddies this assertion.
    hangingIds.add(propId);

    const apolloResponder = (e) => {
      const { requestId, propertyIds } = e.detail;
      const results = {};
      for (const id of propertyIds) {
        results[id] = { items: [{ header: "Pets", text: "No pets allowed." }] };
      }
      globalThis.window.dispatchEvent(new CustomEvent("vdp-search-apollo-data", { detail: { requestId, results } }));
    };
    globalThis.window.addEventListener("vdp-search-apollo-request", apolloResponder);
    t.after(() => {
      globalThis.window.removeEventListener("vdp-search-apollo-request", apolloResponder);
      hangingIds.delete(propId);
    });

    const queue = __test.getSearchQueue();
    const setCachedCalls = [];
    const originalSetCached = queue.setCached.bind(queue);
    queue.setCached = (id, data, options) => {
      setCachedCalls.push({ id, options });
      return originalSetCached(id, data, options);
    };

    const card = makeCard("fastpath-card", listingUrlFor(propId));
    __test.scanSearchCards();
    fireIntersection([{ card, inView: true }]);
    await sleep(700); // dwell floor + jitter -> enqueueSearch fires

    const fastPathCall = setCachedCalls.find((c) => c.id === propId);
    assert.ok(fastPathCall, "the fast path must call setCached for the definitive hit");
    assert.equal(fastPathCall.options?.persist, false, "the fast-path call site must opt out of persistence");

    assert.equal(
      [...storageData.keys()].some((k) => k.includes(propId)),
      false,
      "a rich/definitive fast-path hit must not write to chrome.storage.local"
    );

    const cached = await queue.getCached(propId);
    assert.ok(cached, "the fast-path result must still be servable from the in-memory cache");
    assert.equal(cached.policy.petsAllowed, false);

    assert.deepEqual(
      spies.enqueue.map((e) => e.propId),
      [propId],
      "a rich/definitive hit still schedules the full listing fetch behind it"
    );
  });

  await t.test("Issue #31 sub-fix 2: a badge-slot insertion buried in a container mutation stays internal", async () => {
    freshSearchPage();
    const card = makeCard("slot-mutation-card", listingUrlFor("1000001"));
    __test.scanSearchCards();

    const before = __test.getSearchStats().scans;

    // Real-world shape: the mutation record's target is the slot's new
    // parent (the card's content column), not the slot itself, because
    // childList mutations report the container as target. addedNodes still
    // holds the freshly-inserted .vdp-badge-slot.
    const container = card.querySelector(".uitk-card-content");
    const slot = mockDocument.createElement("div");
    slot.classList.add("vdp-badge-slot");
    container.appendChild(slot);

    mutationObservers[mutationObservers.length - 1].fire([{ target: container, addedNodes: [slot] }]);

    assert.equal(
      __test.getSearchStats().scans,
      before,
      "a badge-slot insertion trapped in a container mutation must not trigger a re-scan"
    );

    // Control: a genuinely external mutation on the same kind of node must
    // still trigger a re-scan — the hardening must not swallow real changes.
    fireMutation();
    assert.equal(
      __test.getSearchStats().scans,
      before + 1,
      "a real external mutation must still trigger a re-scan"
    );
  });
});

// ---------------------------------------------------------------------------
// expandCollapsedSections: TOGGLE_TEXT_RE short-circuit regression.
//
// perf/pipeline-hotspots-and-lru-cache reordered the candidate filter to run
// the cheap checks before the layout query. A TOGGLE_TEXT_RE label match
// (e.g. "Show more") is meant to expand a section on its own, independent of
// aria-expanded/inRelevantSection — that's the whole reason the code checks
// TOGGLE_TEXT_RE before falling back to the aria-expanded+section check. A
// naive reordering can accidentally AND the two signals together instead of
// preserving that short-circuit.
// ---------------------------------------------------------------------------

test("content.js: expandCollapsedSections keeps the TOGGLE_TEXT_RE short-circuit", async (t) => {
  installHarness();

  await t.test("a toggle-labeled button with aria-expanded=false outside a relevant section still expands", async () => {
    for (const child of mockDocument.body.childNodes.slice()) child.remove();
    globalThis.location.href = LISTING_URL;

    // Ancestor text never mentions house rules/policies/amenities/about
    // this property/pets/dogs, so inRelevantSection(el) is false. The only
    // signal that should still grant expansion is the label match itself.
    const wrapper = mockDocument.body.appendChild(new MockNode("div"));
    const reviewsSection = wrapper.appendChild(new MockNode("div"));
    const button = reviewsSection.appendChild(new MockNode("button"));
    button.textContent = "Show more";
    button.setAttribute("aria-expanded", "false");

    let clicked = false;
    button.click = () => { clicked = true; };

    await __test.expandCollapsedSections();

    assert.equal(
      clicked,
      true,
      "a TOGGLE_TEXT_RE label match must expand the section regardless of aria-expanded/section relevance"
    );
  });
});

test("content.js: rAF-batched scroll velocity tracking and settle detection (Issue #23)", async (t) => {
  installHarness();

  await t.test("first scroll event establishes baseline without false-positive velocity pause", async () => {
    globalThis.location.href = SEARCH_URL_A;
    __test.cleanupSearchManager();
    __test.initSearchManager();

    const queue = __test.getSearchQueue();
    assert.ok(queue, "searchQueue must be initialized");
    assert.equal(queue.isScrollPaused(), false);

    // First scroll event
    globalThis.window.scrollY = 100;
    __test.onWindowScroll();
    await new Promise((r) => setTimeout(r, 25)); // allow rAF callback to execute

    assert.equal(queue.isScrollPaused(), false, "First event must only establish baseline");
    assert.equal(__test.getIsScrollPaused(), false);

    __test.cleanupSearchManager();
  });

  await t.test("sustained scroll exceeding velocity threshold pauses queue and resumes on settle debounce", async () => {
    globalThis.location.href = SEARCH_URL_A;
    __test.cleanupSearchManager();
    __test.initSearchManager();

    const queue = __test.getSearchQueue();

    // 1. Establish baseline at scrollY = 0
    globalThis.window.scrollY = 0;
    __test.onWindowScroll();
    await new Promise((r) => setTimeout(r, 25));

    // 2. Simulate fast scroll: 500px down in 25ms = 20,000 px/s (well above 150 px/s threshold)
    globalThis.window.scrollY = 500;
    __test.onWindowScroll();
    await new Promise((r) => setTimeout(r, 25));

    assert.equal(queue.isScrollPaused(), true, "Queue must pause when scroll velocity >= 150 px/s");
    assert.equal(__test.getIsScrollPaused(), true);

    // 3. Wait for settle debounce (150ms)
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(queue.isScrollPaused(), false, "Queue must unpause after scroll settle debounce expires");
    assert.equal(__test.getIsScrollPaused(), false);

    __test.cleanupSearchManager();
  });

  await t.test("native scrollend event immediately settles scroll pause without waiting for debounce", async () => {
    globalThis.location.href = SEARCH_URL_A;
    __test.cleanupSearchManager();
    __test.initSearchManager();

    const queue = __test.getSearchQueue();

    // 1. Baseline
    globalThis.window.scrollY = 0;
    __test.onWindowScroll();
    await new Promise((r) => setTimeout(r, 25));

    // 2. Fast scroll
    globalThis.window.scrollY = 600;
    __test.onWindowScroll();
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(queue.isScrollPaused(), true);

    // 3. Dispatch scrollend directly
    __test.onScrollSettled();
    assert.equal(queue.isScrollPaused(), false, "onScrollSettled must immediately unpause queue");

    __test.cleanupSearchManager();
  });

  await t.test("cleanupSearchManager tears down window scroll listeners and cancels pending rAF / settle timers", async () => {
    globalThis.location.href = SEARCH_URL_A;
    __test.cleanupSearchManager();
    __test.initSearchManager();

    assert.ok(globalThis.window._listeners.get("scroll")?.size > 0, "scroll listener must be attached");

    // Initiate scroll activity
    globalThis.window.scrollY = 100;
    __test.onWindowScroll();

    __test.cleanupSearchManager();

    assert.equal(globalThis.window._listeners.get("scroll")?.size || 0, 0, "scroll listener must be removed");
    assert.equal(__test.getIsScrollPaused(), false, "isScrollPaused must reset to false");
  });

  await t.test("multiple consecutive initSearchManager calls do not accumulate duplicate scroll listeners", async () => {
    globalThis.location.href = SEARCH_URL_A;
    __test.cleanupSearchManager();

    // Call initSearchManager multiple times (e.g. simulating consecutive SPA search query updates)
    __test.initSearchManager();
    __test.initSearchManager();
    __test.initSearchManager();

    assert.equal(__test.getScrollListenersAttached(), true);
    assert.equal(globalThis.window._listeners.get("scroll")?.size, 1, "exactly one scroll listener must be attached");

    __test.cleanupSearchManager();
    assert.equal(__test.getScrollListenersAttached(), false);
    assert.equal(globalThis.window._listeners.get("scroll")?.size || 0, 0, "scroll listener must be cleanly removed");
  });
});

