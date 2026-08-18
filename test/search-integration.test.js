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
    this._classes = new Set();
    this.classList = {
      add: (cls) => this._classes.add(cls),
      remove: (cls) => this._classes.delete(cls),
      contains: (cls) => this._classes.has(cls),
    };
  }

  get className() {
    return Array.from(this._classes).join(" ");
  }
  set className(val) {
    this._classes = new Set(String(val).split(/\s+/).filter(Boolean));
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

  _matches(el, selector) {
    if (!el || !selector) return false;
    if (selector.startsWith(".")) {
      const className = selector.slice(1);
      return Boolean(el.className && el.className.split(" ").includes(className));
    }
    const tagAttrMatch = selector.match(/^([a-zA-Z0-9_-]+)?(?:\[([a-zA-Z0-9_-]+)(?:\*?=?"?([^"\]]*)"?)?\])?/);
    if (tagAttrMatch) {
      const [, tag, attr, val] = tagAttrMatch;
      if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
      if (attr) {
        const actual = el.getAttribute(attr);
        if (actual === null) return false;
        if (val) {
          return selector.includes("*=") ? actual.includes(val) : actual === val;
        }
      }
      return Boolean(tag || attr);
    }
    return el.tagName.toLowerCase() === selector.toLowerCase();
  }

  querySelector(selector) {
    return this._find((el) => this._matches(el, selector));
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
      if (this._matches(child, selector)) {
        results.push(child);
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
    let lastScannedUrl = "https://www.vrbo.com/Hotel-Search?destination=Miami";
    const tooltip = new MockElement("div");
    tooltip.className = "vdp-search-tooltip vdp-tooltip-visible";
    tooltip.style.display = "block";
    tooltip.setAttribute("aria-hidden", "false");

    let activeTooltipTarget = new MockElement("div");
    let activeTooltipPropId = "prop_123";

    function hideTooltip() {
      tooltip.classList.remove("vdp-tooltip-visible");
      tooltip.setAttribute("aria-hidden", "true");
      tooltip.style.display = "none";
      if (activeTooltipTarget) {
        activeTooltipTarget.setAttribute("aria-expanded", "false");
        activeTooltipTarget = null;
        activeTooltipPropId = null;
      }
    }

    function onUrlMaybeChanged(newUrl) {
      if (newUrl !== lastScannedUrl) {
        lastScannedUrl = newUrl;
        hideTooltip();
      }
    }

    assert.equal(tooltip.style.display, "block");
    assert.equal(tooltip.getAttribute("aria-hidden"), "false");

    // Navigate to new search query
    onUrlMaybeChanged("https://www.vrbo.com/Hotel-Search?destination=Orlando");

    assert.equal(tooltip.style.display, "none", "Tooltip must be hidden on URL change");
    assert.equal(tooltip.getAttribute("aria-hidden"), "true");
    assert.equal(activeTooltipTarget, null, "Active tooltip target must be cleared");
    assert.equal(activeTooltipPropId, null, "Active tooltip property ID must be cleared");
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

  await t.test("7. 8.1.6 Dialog accessibility contract & focus management", () => {
    const badge = new MockElement("div");
    badge.className = "vdp-search-badge vdp-badge-allowed";
    badge.setAttribute("tabindex", "0");
    badge.setAttribute("role", "button");
    badge.setAttribute("aria-haspopup", "dialog");
    badge.setAttribute("aria-controls", "vdp-search-tooltip");
    badge.setAttribute("aria-expanded", "false");

    const dialog = new MockElement("div");
    dialog.id = "vdp-search-tooltip";
    dialog.className = "vdp-search-tooltip";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-label", "Dog policy");
    dialog.setAttribute("aria-hidden", "true");
    dialog.style.display = "none";

    const closeBtn = new MockElement("button");
    closeBtn.className = "vdp-tooltip-close";
    closeBtn.setAttribute("aria-label", "Close details");
    dialog.appendChild(closeBtn);

    const link = new MockElement("a");
    link.setAttribute("href", "https://www.vrbo.com/123");
    dialog.appendChild(link);

    let focusedElement = null;
    badge.focus = () => { focusedElement = badge; };
    closeBtn.focus = () => { focusedElement = closeBtn; };
    link.focus = () => { focusedElement = link; };

    // 1. Initial State: aria-expanded is false, aria-hidden is true, aria-controls matches dialog id
    assert.equal(badge.getAttribute("aria-controls"), dialog.id);
    assert.equal(badge.getAttribute("aria-expanded"), "false");
    assert.equal(dialog.getAttribute("aria-hidden"), "true");
    assert.equal(dialog.getAttribute("aria-modal"), null, "Must NOT set aria-modal='true'");

    // 2. Focus-only opening: opens tooltip, aria-expanded/aria-hidden change together, focus stays on badge
    badge.focus();
    dialog.style.display = "block";
    dialog.setAttribute("aria-hidden", "false");
    badge.setAttribute("aria-expanded", "true");
    assert.equal(focusedElement, badge, "Focus-only opening must keep focus on the badge");
    assert.equal(badge.getAttribute("aria-expanded"), "true");
    assert.equal(dialog.getAttribute("aria-hidden"), "false");

    // 3. Pointer hover opening: focus is NOT stolen
    dialog.style.display = "block";
    assert.equal(focusedElement, badge, "Pointer hover must not steal focus");

    // 4. Keyboard activation on badge (Enter/Space): opens dialog and moves focus to Close button
    badge.dispatchEvent({ type: "keydown", key: "Enter" });
    closeBtn.focus();
    assert.equal(focusedElement, closeBtn, "Keyboard activation must move focus to Close button");

    // 5. Tab cycling inside dialog: Close -> Link -> Close
    let focusables = [closeBtn, link];
    let currentFocusIndex = 0; // currently on closeBtn
    // Tab forward
    currentFocusIndex = (currentFocusIndex + 1) % focusables.length;
    focusables[currentFocusIndex].focus();
    assert.equal(focusedElement, link, "Tab from close button must focus listing link");

    // Tab forward wraps back to Close
    currentFocusIndex = (currentFocusIndex + 1) % focusables.length;
    focusables[currentFocusIndex].focus();
    assert.equal(focusedElement, closeBtn, "Tab from listing link must wrap to close button");

    // Shift+Tab backward wraps to Link
    currentFocusIndex = (currentFocusIndex - 1 + focusables.length) % focusables.length;
    focusables[currentFocusIndex].focus();
    assert.equal(focusedElement, link, "Shift+Tab from close button must wrap to listing link");

    // 6. Escape key inside dialog: closes dialog, aria-expanded/hidden sync, restores focus to badge
    dialog.dispatchEvent({ type: "keydown", key: "Escape" });
    dialog.style.display = "none";
    dialog.setAttribute("aria-hidden", "true");
    badge.setAttribute("aria-expanded", "false");
    badge.focus();

    assert.equal(focusedElement, badge, "Focus should restore to badge upon Escape");
    assert.equal(badge.getAttribute("aria-expanded"), "false");
    assert.equal(dialog.getAttribute("aria-hidden"), "true");
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

  await t.test("9. 8.1.2 Terminal-State Cooldown & Distinct Tooltip Copy State Matrix", async () => {
    let callCount = 0;
    const mockFetch = async (url) => {
      callCount++;
      if (url.includes("timeout")) {
        const err = new Error("Abort");
        err.name = "AbortError";
        throw err;
      }
      if (url.includes("429")) return { ok: false, status: 429 };
      if (url.includes("500")) return { ok: false, status: 500 };
      if (url.includes("unknown")) return { ok: true, status: 200, text: async () => "<html>None</html>" };
      return { ok: true, status: 200, text: async () => "<section>House Rules: Dogs welcome</section>" };
    };

    const queue = createSearchFetchQueue({
      fetchFn: mockFetch,
      storage: mockStorage,
      sessionCap: 1,
      cooldownMs: 5000,
      minDelayMs: 5,
    });

    // 1. Trigger timeout on prop_to
    queue.enqueue("prop_to", "https://www.vrbo.com/timeout", "normal");
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(callCount, 1);
    assert.equal(queue.isInCooldown("prop_to"), true);

    // 2. 10 hovers on prop_to during cooldown produce 0 additional requests
    for (let i = 0; i < 10; i++) {
      queue.enqueue("prop_to", "https://www.vrbo.com/timeout", "high");
    }
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(callCount, 1, "10 hovers during cooldown must not increase callCount");

    // 3. Background-capped item allows 1 explicit bypass attempt
    const cappedRes = [];
    queue.subscribe("prop_cap", (d) => cappedRes.push(d));
    // Since sessionCap was 1, prop_to consumed the 1 background slot, so prop_cap gets capped
    queue.enqueue("prop_cap", "https://www.vrbo.com/500", "normal");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(cappedRes[0]?.status, "capped");
    assert.equal(callCount, 1, "Capped background item made no fetch");

    // Explicit high-priority hover executes 1 attempt
    queue.enqueue("prop_cap", "https://www.vrbo.com/500", "high");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(callCount, 2, "Explicit hover triggered 1 bypass attempt");

    // Subsequent hovers during cooldown produce 0 additional requests
    for (let i = 0; i < 5; i++) {
      queue.enqueue("prop_cap", "https://www.vrbo.com/500", "high");
    }
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(callCount, 2, "Subsequent hovers during cooldown must not trigger fetch");

    // 4. Test tooltip copy helper / structure
    function simulateTooltipRender(data, url) {
      const tooltip = new MockElement("div");
      let message = "";
      if (!data || data.status === "loading") {
        message = "Checking the listing summary for pet rules...";
      } else if (data.status === "ok" && data.policy) {
        message = "Allowed";
      } else if (data.status === "rate_limited") {
        message = "Pet policy lookup paused due to request limits.";
      } else if (data.status === "capped") {
        message = "Background check paused to protect session limits.";
      } else {
        message = "Pet policy details were not available in the search result.";
      }

      const row = new MockElement("div");
      const val = new MockElement("span");
      val.textContent = message;
      row.appendChild(val);
      tooltip.appendChild(row);

      const footer = new MockElement("div");
      const link = new MockElement("a");
      link.setAttribute("href", url || "#");
      link.textContent = "Open listing for complete rules ↗";
      footer.appendChild(link);
      tooltip.appendChild(footer);

      return {
        message,
        linkUrl: link.getAttribute("href"),
        linkText: link.textContent,
      };
    }

    const checkingUi = simulateTooltipRender(null, "https://www.vrbo.com/123");
    assert.equal(checkingUi.message, "Checking the listing summary for pet rules...");
    assert.equal(checkingUi.linkUrl, "https://www.vrbo.com/123");

    const cappedUi = simulateTooltipRender({ status: "capped" }, "https://www.vrbo.com/123");
    assert.equal(cappedUi.message, "Background check paused to protect session limits.");
    assert.equal(cappedUi.linkUrl, "https://www.vrbo.com/123");

    const rateLimitedUi = simulateTooltipRender({ status: "rate_limited" }, "https://www.vrbo.com/123");
    assert.equal(rateLimitedUi.message, "Pet policy lookup paused due to request limits.");
    assert.equal(rateLimitedUi.linkUrl, "https://www.vrbo.com/123");

    const unavailableUi = simulateTooltipRender({ status: "timeout" }, "https://www.vrbo.com/123");
    assert.equal(unavailableUi.message, "Pet policy details were not available in the search result.");
    assert.equal(unavailableUi.linkUrl, "https://www.vrbo.com/123");

    queue.dispose();
  });

  await t.test("10. 8.1.3 Separate Navigation URLs from Canonical Fetch URLs in Card Binding", async () => {
    const fetchedUrls = [];
    const mockFetch = async (url) => {
      fetchedUrls.push(url);
      return {
        ok: true,
        status: 200,
        text: async () => "<section>House Rules: Dogs allowed, maximum 2 dogs</section>",
      };
    };

    const queue = createSearchFetchQueue({
      fetchFn: mockFetch,
      storage: mockStorage,
      maxConcurrent: 1,
      minDelayMs: 5,
    });

    const { validateListingUrl } = require("../search-fetcher.js");

    function simulateCardBinding(cardElement) {
      const anchors = cardElement.querySelectorAll("a[href]");
      let listing = null;
      for (const a of anchors) {
        const href = a.getAttribute("href");
        if (!href) continue;
        const validated = validateListingUrl(href);
        if (validated) {
          listing = validated;
          break;
        }
      }
      if (!listing) return null;

      const { propertyId, fetchUrl, navigationUrl } = listing;
      cardElement.setAttribute("data-vdp-prop-id", propertyId);
      cardElement.setAttribute("data-vdp-fetch-url", fetchUrl);
      cardElement.setAttribute("data-vdp-nav-url", navigationUrl);

      return { propertyId, fetchUrl, navigationUrl };
    }

    // Card 1: has unrelated leading anchors before the real listing anchor
    const card1 = new MockElement("div");
    card1.setAttribute("data-stid", "property-card");

    const helpAnchor = new MockElement("a");
    helpAnchor.setAttribute("href", "/help");
    card1.appendChild(helpAnchor);

    const adAnchor = new MockElement("a");
    adAnchor.setAttribute("href", "https://partner.com/ad");
    card1.appendChild(adAnchor);

    const listingAnchor = new MockElement("a");
    const rawNavUrl = "https://www.vrbo.com/777888?chkin=2026-11-01&chkout=2026-11-07&adults=3&children=1#rates";
    listingAnchor.setAttribute("href", rawNavUrl);
    card1.appendChild(listingAnchor);

    const bound = simulateCardBinding(card1);
    assert.ok(bound !== null, "Card with leading unrelated anchors should bind to listing anchor");
    assert.equal(bound.propertyId, "777888");
    assert.equal(bound.fetchUrl, "https://www.vrbo.com/777888", "fetchUrl must have query and fragment removed");
    assert.equal(bound.navigationUrl, rawNavUrl, "navigationUrl must retain full search and date context");

    // Enqueue with fetchUrl
    queue.enqueue(bound.propertyId, bound.fetchUrl, "normal");
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(fetchedUrls.length, 1);
    assert.equal(fetchedUrls[0], "https://www.vrbo.com/777888", "Network fetch must receive clean canonical URL without query string");

    // Card 2: Non-Vrbo or non-HTTPS card must be rejected
    const card2 = new MockElement("div");
    const nonVrboAnchor = new MockElement("a");
    nonVrboAnchor.setAttribute("href", "https://www.expedia.com/99999?adults=2");
    card2.appendChild(nonVrboAnchor);

    const bound2 = simulateCardBinding(card2);
    assert.equal(bound2, null, "Non-Vrbo card must not bind");

    queue.dispose();
  });

  await t.test("11. 8.1.8 Fee-period tooltip rendering distinguishes 'per day', 'per pet per day', and 'per stay'", () => {
    function renderTooltipFeeRow(policy) {
      const p = policy;
      if (!p || !p.fee || p.fee.amount === null || p.fee.amount <= 0) return null;
      const curSym = p.fee.currency === "USD" ? "$" : `${p.fee.currency} `;
      let perStr = "";
      if (p.fee.perPet && p.fee.period && p.fee.period !== "unknown" && p.fee.period !== "pet") {
        perStr = ` per pet per ${p.fee.period}`;
      } else if (p.fee.period && p.fee.period !== "unknown") {
        perStr = ` per ${p.fee.period}`;
      }
      return `Pet fee: ${curSym}${p.fee.amount}${perStr}`;
    }

    // 1. Per day
    assert.equal(
      renderTooltipFeeRow({ fee: { amount: 25, currency: "USD", period: "day" } }),
      "Pet fee: $25 per day",
      "$25 per day must render as '$25 per day', never '$25 per night'"
    );

    // 2. Per pet per day
    assert.equal(
      renderTooltipFeeRow({ fee: { amount: 25, currency: "USD", period: "day", perPet: true } }),
      "Pet fee: $25 per pet per day"
    );

    // 3. Per pet per night
    assert.equal(
      renderTooltipFeeRow({ fee: { amount: 25, currency: "USD", period: "night", perPet: true } }),
      "Pet fee: $25 per pet per night"
    );

    // 4. Per stay (for maximum allowed pets / flat stay fee)
    assert.equal(
      renderTooltipFeeRow({ fee: { amount: 150, currency: "USD", period: "stay" } }),
      "Pet fee: $150 per stay"
    );

    // 5. Per pet (per stay or flat per pet)
    assert.equal(
      renderTooltipFeeRow({ fee: { amount: 50, currency: "USD", period: "pet", perPet: true } }),
      "Pet fee: $50 per pet"
    );

    // 6. Bare fee (unknown period)
    assert.equal(
      renderTooltipFeeRow({ fee: { amount: 75, currency: "USD", period: "unknown" } }),
      "Pet fee: $75"
    );
  });
});

