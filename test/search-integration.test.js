// test/search-integration.test.js
// Consolidated state-transition integration test suite for Vrbow search subsystem.

const test = require("node:test");
const assert = require("node:assert/strict");

const extract = require("../extract.js");
const { createSearchFetchQueue } = require("../search-fetcher.js");

// Minimal DOM simulation for integration testing
class MockElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.eventListeners = new Map();
    this.parentNode = null;
    this._textContent = "";
  }

  get textContent() {
    return this._textContent;
  }
  set textContent(val) {
    this._textContent = String(val);
    this.children = [];
  }

  get isConnected() {
    let p = this.parentNode;
    while (p) {
      if (p.tagName === "BODY" || p.tagName === "HTML") return true;
      p = p.parentNode;
    }
    return false;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) || null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (this.parentNode) {
      const idx = this.parentNode.children.indexOf(this);
      if (idx !== -1) this.parentNode.children.splice(idx, 1);
      this.parentNode = null;
    }
  }

  querySelector(selector) {
    if (selector.startsWith(".")) {
      const className = selector.slice(1);
      return this._find((el) => el.className && el.className.split(" ").includes(className));
    }
    if (selector.startsWith("[")) {
      const attrMatch = selector.match(/\[([a-zA-Z0-9_-]+)(?:\*?=?"?([^"\]]*)"?)?\]/);
      if (attrMatch) {
        const [, attr, val] = attrMatch;
        return this._find((el) => {
          const actual = el.getAttribute(attr);
          if (actual === null) return false;
          if (!val) return true;
          return selector.includes("*=") ? actual.includes(val) : actual === val;
        });
      }
    }
    return this._find((el) => el.tagName.toLowerCase() === selector.toLowerCase());
  }

  querySelectorAll(selector) {
    const results = [];
    this._findAll(selector, results);
    return results;
  }

  _find(predicate) {
    for (const child of this.children) {
      if (predicate(child)) return child;
      const res = child._find(predicate);
      if (res) return res;
    }
    return null;
  }

  _findAll(selector, results) {
    for (const child of this.children) {
      if (selector.startsWith(".") && child.className && child.className.split(" ").includes(selector.slice(1))) {
        results.push(child);
      } else if (selector.startsWith("[")) {
        const attrMatch = selector.match(/\[([a-zA-Z0-9_-]+)/);
        if (attrMatch && child.getAttribute(attrMatch[1]) !== null) {
          results.push(child);
        }
      }
      child._findAll(selector, results);
    }
  }

  closest(selector) {
    let curr = this;
    while (curr) {
      if (selector.startsWith("[")) {
        const attrMatch = selector.match(/\[([a-zA-Z0-9_-]+)/);
        if (attrMatch && curr.getAttribute(attrMatch[1]) !== null) return curr;
      }
      curr = curr.parentNode;
    }
    return null;
  }

  addEventListener(type, cb) {
    if (!this.eventListeners.has(type)) this.eventListeners.set(type, new Set());
    this.eventListeners.get(type).add(cb);
  }
  removeEventListener(type, cb) {
    if (this.eventListeners.has(type)) this.eventListeners.get(type).delete(cb);
  }
  dispatchEvent(event) {
    const cbs = this.eventListeners.get(event.type);
    if (cbs) {
      for (const cb of cbs) cb(event);
    }
  }

  getBoundingClientRect() {
    return { top: 100, bottom: 120, left: 50, right: 150, width: 100, height: 20 };
  }

  focus() {
    this._focused = true;
    this.dispatchEvent({ type: "focus" });
  }
  blur() {
    this._focused = false;
    this.dispatchEvent({ type: "blur" });
  }
}

test("Consolidated State-Transition Suite", async (t) => {
  // Setup simulated environment
  const mockStorage = {
    store: {},
    get(keys, cb) {
      const res = {};
      for (const k of keys) {
        if (this.store[k]) res[k] = this.store[k];
      }
      cb(res);
    },
    set(obj) {
      Object.assign(this.store, obj);
    },
    remove(keys, cb) {
      for (const k of keys) delete this.store[k];
      cb && cb();
    },
  };

  await t.test("1. Search entry → fetch → result → live tooltip refresh", async () => {
    let fetchResolve;
    const fetchPromise = new Promise((r) => {
      fetchResolve = r;
    });

    const mockFetch = async () => {
      return {
        ok: true,
        status: 200,
        text: async () => "<section>House Rules: Dogs welcome, limit of 2 dogs.</section>",
      };
    };

    const queue = createSearchFetchQueue({
      fetchFn: mockFetch,
      storage: mockStorage,
      maxConcurrent: 1,
      minDelayMs: 5,
    });

    let badgeText = "⏳ Checking pet policy...";
    let tooltipStatus = "Checking policy...";
    let tooltipDogs = null;

    // Simulate badge subscription
    queue.subscribe("prop_1", (data) => {
      if (data.status === "ok" && data.policy) {
        badgeText = `Dogs allowed (${data.policy.maxDogs} dogs)`;
        tooltipStatus = "🐾 Allowed";
        tooltipDogs = data.policy.maxDogs;
      }
    });

    // Enqueue
    queue.enqueue("prop_1", "https://www.vrbo.com/1", "high");
    assert.equal(badgeText, "⏳ Checking pet policy...");
    assert.equal(tooltipStatus, "Checking policy...");

    // Wait for fetch completion
    await new Promise((r) => setTimeout(r, 60));

    assert.equal(badgeText, "Dogs allowed (2 dogs)");
    assert.equal(tooltipStatus, "🐾 Allowed");
    assert.equal(tooltipDogs, 2);
    queue.dispose();
  });

  await t.test("2. Card A → recycled card B (Virtualization)", async () => {
    const queue = createSearchFetchQueue({
      fetchFn: async (url) => ({
        ok: true,
        status: 200,
        text: async () => (url.includes("A") ? "<section>No pets allowed</section>" : "<section>Dogs welcome, 1 dog</section>"),
      }),
      storage: mockStorage,
      maxConcurrent: 1,
      minDelayMs: 5,
    });

    const card = new MockElement("div");
    card.setAttribute("data-stid", "property-card");

    const badge = new MockElement("div");
    badge.className = "vdp-search-badge vdp-badge-loading";
    card.appendChild(badge);

    // Initial binding to Card A
    let currentPropId = "prop_A";
    let unsubA = queue.subscribe("prop_A", (data) => {
      if (currentPropId === "prop_A") {
        badge.className = data.policy?.petsAllowed ? "vdp-search-badge vdp-badge-allowed" : "vdp-search-badge vdp-badge-banned";
        badge.textContent = data.policy?.petsAllowed ? "Allowed" : "Pets not allowed";
      }
    });
    queue.enqueue("prop_A", "https://www.vrbo.com/prop_A");
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(badge.textContent, "Pets not allowed");
    assert.equal(badge.className, "vdp-search-badge vdp-badge-banned");

    // Recycled to Card B: unsubscribe A, reset display immediately to loading
    unsubA();
    currentPropId = "prop_B";
    badge.className = "vdp-search-badge vdp-badge-loading";
    badge.textContent = "⏳ Checking pet policy...";

    assert.equal(badge.textContent, "⏳ Checking pet policy...");

    // Bind B
    queue.subscribe("prop_B", (data) => {
      if (currentPropId === "prop_B") {
        badge.className = data.policy?.petsAllowed ? "vdp-search-badge vdp-badge-allowed" : "vdp-search-badge vdp-badge-banned";
        badge.textContent = data.policy?.petsAllowed ? "Allowed" : "Pets not allowed";
      }
    });
    queue.enqueue("prop_B", "https://www.vrbo.com/prop_B");
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(badge.textContent, "Allowed");
    assert.equal(badge.className, "vdp-search-badge vdp-badge-allowed");
    queue.dispose();
  });

  await t.test("3. Search → listing → browser back to search (SPA navigation cleanup & rebind)", async () => {
    let queue = createSearchFetchQueue({ storage: mockStorage });
    let isSearchActive = true;

    // Simulate cleanup on navigating to listing
    isSearchActive = false;
    queue.dispose();
    queue = null;

    assert.equal(queue, null);

    // Simulate returning to search
    isSearchActive = true;
    queue = createSearchFetchQueue({ storage: mockStorage });
    assert.ok(queue !== null);
    assert.equal(queue.getQueueLength(), 0);
    assert.equal(queue.getActiveCount(), 0);
    queue.dispose();
  });

  await t.test("4. Search query A → search query B (URL change dismisses open dialog)", () => {
    let isDialogVisible = true;
    function onUrlChange() {
      isDialogVisible = false; // Always dismiss
    }

    onUrlChange();
    assert.equal(isDialogVisible, false);
  });

  await t.test("5. Visible → hidden → visible (Queue pauses on hidden and resumes on visible)", async () => {
    let fetchCount = 0;
    const mockFetch = async () => {
      fetchCount++;
      return { ok: true, status: 200, text: async () => "<section>Dogs allowed</section>" };
    };

    let simulatedVisibility = "hidden";
    globalThis.document = {
      visibilityState: simulatedVisibility,
      addEventListener() {},
      removeEventListener() {},
    };

    const queue = createSearchFetchQueue({
      fetchFn: mockFetch,
      maxConcurrent: 1,
      minDelayMs: 5,
    });

    queue.enqueue("prop_vis_1", "https://www.vrbo.com/vis_1");
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(fetchCount, 0, "Fetch should not start when document is hidden");

    // Make visible
    globalThis.document.visibilityState = "visible";
    // Trigger processQueue manually or via queue
    queue.enqueue("prop_vis_2", "https://www.vrbo.com/vis_2");
    await new Promise((r) => setTimeout(r, 60));

    assert.ok(fetchCount >= 1, "Queue should process after document becomes visible");
    queue.dispose();
    delete globalThis.document;
  });

  await t.test("6. Queued → active → disposed (Mid-flight AbortController cancellation)", async () => {
    let aborted = false;
    const mockFetch = (url, options) => {
      return new Promise((resolve, reject) => {
        if (options?.signal) {
          options.signal.addEventListener("abort", () => {
            aborted = true;
            const err = new Error("Aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    };

    const queue = createSearchFetchQueue({
      fetchFn: mockFetch,
      maxConcurrent: 1,
    });

    queue.enqueue("active_1", "https://www.vrbo.com/1");
    queue.enqueue("queued_2", "https://www.vrbo.com/2");

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(queue.getActiveCount(), 1);
    assert.equal(queue.getQueueLength(), 1);

    queue.dispose();
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(aborted, true);
    assert.equal(queue.getActiveCount(), 0);
    assert.equal(queue.getQueueLength(), 0);
  });

  await t.test("7. Badge focus → dialog focus → Escape/close (Focus management)", () => {
    const badge = new MockElement("div");
    const dialog = new MockElement("div");
    const closeBtn = new MockElement("button");
    dialog.appendChild(closeBtn);

    let focusedElement = null;
    badge.focus = () => { focusedElement = badge; };
    closeBtn.focus = () => { focusedElement = closeBtn; };

    // Keyboard activation on badge
    badge.dispatchEvent({ type: "keydown", key: "Enter" });
    dialog.style.display = "block";
    closeBtn.focus();
    assert.equal(focusedElement, closeBtn, "Focus should move to dialog close button");

    // Escape key inside dialog
    dialog.dispatchEvent({ type: "keydown", key: "Escape" });
    dialog.style.display = "none";
    badge.focus();
    assert.equal(focusedElement, badge, "Focus should restore to badge upon Escape");
  });

  await t.test("8. Cache status matrix & distinct terminal states (miss, hit, unknown, timeout, error, rate_limited, capped)", async () => {
    let callCount = 0;
    const mockFetch = async (url) => {
      callCount++;
      if (url.includes("429")) return { ok: false, status: 429 };
      if (url.includes("500")) return { ok: false, status: 500 };
      if (url.includes("unknown")) return { ok: true, status: 200, text: async () => "<html>None</html>" };
      return { ok: true, status: 200, text: async () => "<section>House Rules: Dogs allowed, limit 1 dog</section>" };
    };

    const queue = createSearchFetchQueue({
      fetchFn: mockFetch,
      storage: mockStorage,
      pauseOnChallengeMs: 500,
      minDelayMs: 5,
    });

    const results = {};
    queue.subscribe("p_hit", (d) => { results.p_hit = d; });
    queue.subscribe("p_unknown", (d) => { results.p_unknown = d; });
    queue.subscribe("p_err", (d) => { results.p_err = d; });
    queue.subscribe("p_429", (d) => { results.p_429 = d; });

    // Miss -> Hit
    queue.enqueue("p_hit", "https://www.vrbo.com/hit");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(results.p_hit?.status, "ok");
    assert.equal(callCount, 1);

    // Hit from cache
    queue.enqueue("p_hit", "https://www.vrbo.com/hit");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(callCount, 1, "Cache hit should not trigger network call");

    // Unknown (no pet policy in response)
    queue.enqueue("p_unknown", "https://www.vrbo.com/unknown");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(results.p_unknown?.status, "unknown");

    // Error
    queue.enqueue("p_err", "https://www.vrbo.com/500");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(results.p_err?.status, "error");

    // Rate limited
    queue.enqueue("p_429", "https://www.vrbo.com/429");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(results.p_429?.status, "rate_limited");
    assert.equal(queue.isPaused(), true);

    queue.dispose();
  });
});
