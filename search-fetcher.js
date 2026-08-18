// search-fetcher.js
// Throttled background queue and persistent cache for search result pet policies.

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./extract.js"));
  } else {
    root.VdpSearchFetcher = factory(root.VDPExtract || root.VdpExtract);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (extract) {
  "use strict";

  const CACHE_PREFIX = "vrbow_cache_";
  const CACHE_VERSION = 1;
  const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  const DEFAULT_CONCURRENCY = 2;
  const DEFAULT_MIN_DELAY_MS = 400;
  const DEFAULT_SESSION_CAP = 40;
  const PAUSE_ON_CHALLENGE_MS = 30000; // 30s backoff if 429 or challenge encountered

  /**
   * Walk Apollo graph with full __ref pointer resolution and support for header.text and value/text leaves.
   */
  function walkApolloNode(state, node, headerCtx, sectionCtx, out, visited = new Set(), depth = 0) {
    if (node == null || depth > 35) return;

    if (node && typeof node === "object" && typeof node.__ref === "string") {
      if (visited.has(node.__ref)) return;
      visited.add(node.__ref);
      const target = state[node.__ref];
      if (target) walkApolloNode(state, target, headerCtx, sectionCtx, out, visited, depth + 1);
      return;
    }

    if (Array.isArray(node)) {
      for (const el of node) walkApolloNode(state, el, headerCtx, sectionCtx, out, visited, depth + 1);
      return;
    }

    if (typeof node !== "object") return;

    let nextHeader = headerCtx;
    let nextSection = sectionCtx;

    const headerText = typeof node.header === "object" ? node.header?.text : (typeof node.header === "string" ? node.header : "");
    if (typeof headerText === "string" && headerText.trim()) {
      nextHeader = headerText.trim();
      if (/house rules|polic|important information/i.test(nextHeader)) nextSection = "House Rules / Policies";
      else if (/about this property|about this space|about this listing/i.test(nextHeader)) nextSection = "About this property";
      else if (!nextSection) nextSection = nextHeader;
    }
    if (typeof node.sectionName === "string" && node.sectionName.trim()) {
      nextHeader = node.sectionName.trim();
      if (/house rules|polic/i.test(nextHeader)) nextSection = "House Rules / Policies";
    }

    for (const [k, v] of Object.entries(node)) {
      if ((k === "value" || k === "text" || k === "body" || k === "description") && typeof v === "string" && v.trim() && v.trim().length > 1) {
        out.push({ header: nextHeader || "Listing Data", section: nextSection || nextHeader || "Rules", text: v.trim() });
      } else if (v && typeof v === "object") {
        walkApolloNode(state, v, nextHeader, nextSection, out, visited, depth + 1);
      }
    }
  }

  /**
   * Parse raw listing HTML into an extract.js-compatible corpus.
   * Resolves Apollo state JSON with __ref references or extracts from HTML sections.
   */
  function parseListingHtml(html, propertyId) {
    if (!html || typeof html !== "string") return null;

    // Check for bot challenges or error pages
    if (/challenge-running|bot or not|cf-browser-verification|captcha/i.test(html)) {
      return { isChallenge: true };
    }

    const items = [];

    // 1. Check for embedded Apollo state in <script> tags
    const apolloMatch = html.match(/window\.__APOLLO_STATE__\s*=\s*(\{.+?\});/s) ||
      html.match(/<script[^>]*id="__APOLLO_STATE__"[^>]*>([\s\S]*?)<\/script>/i);

    if (apolloMatch && apolloMatch[1]) {
      try {
        const state = JSON.parse(apolloMatch[1]);
        const targetKey = propertyId ? `PropertyInfo:${propertyId}` : Object.keys(state).find((k) => k.startsWith("PropertyInfo:"));
        const root = targetKey ? state[targetKey] : null;
        if (root) {
          walkApolloNode(state, root, null, null, items);
        }
      } catch {
        // Fall back to text parsing if JSON parse fails
      }
    }

    // 2. Extract visible text sections from raw HTML (strip markup)
    if (items.length === 0) {
      const sectionRegex = /<(section|div|article)[^>]*>(.*?)<\/\1>/gis;
      let match;
      while ((match = sectionRegex.exec(html)) !== null) {
        const content = match[2];
        if (/pet|dog|house rules|policies|amenities/i.test(content)) {
          const cleanText = content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
          if (cleanText.length > 10 && cleanText.length < 5000) {
            items.push({ header: "House Rules / Policies", section: "Rules", text: cleanText });
          }
        }
      }
    }

    if (items.length === 0) return null;

    // Build corpus and extract policy
    const corpus = extract.buildCorpus({ items }, []);
    if (!corpus || corpus.length === 0) return null;
    const rawPolicy = extract.extractPolicy(corpus);
    if (!rawPolicy || !rawPolicy.found) return null;
    const policy = typeof extract.normalizePolicy === "function"
      ? extract.normalizePolicy(rawPolicy, propertyId, "search-response")
      : rawPolicy;
    return { ok: true, propertyId, policy, rawItemsCount: items.length };
  }

  /**
   * Search Fetch Queue & Cache Manager
   */
  function createSearchFetchQueue(options = {}) {
    const fetchFn = options.fetchFn || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
    const storage = options.storage || (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local ? chrome.storage.local : null);
    const maxConcurrent = options.maxConcurrent || DEFAULT_CONCURRENCY;
    const minDelayMs = options.minDelayMs || DEFAULT_MIN_DELAY_MS;
    const sessionCap = options.sessionCap || DEFAULT_SESSION_CAP;
    const ttlMs = options.ttlMs || DEFAULT_TTL_MS;
    const pauseOnChallengeMs = options.pauseOnChallengeMs || PAUSE_ON_CHALLENGE_MS;

    const memoryCache = new Map();
    const queue = []; // [{ propertyId, url, priority }]
    const activeRequests = new Set();
    const enqueuedOrActive = new Set();
    const subscribers = new Map(); // propertyId -> Set of callbacks
    const highPriorityIds = new Set();

    let sessionRequestsCount = 0;
    let isProcessing = false;
    let pausedUntil = 0;
    let isDisposed = false;
    let lastRequestStartTime = 0;
    let maxObservedConcurrency = 0;
    let pauseTimer = null;

    function subscribe(propertyId, callback) {
      if (!subscribers.has(propertyId)) {
        subscribers.set(propertyId, new Set());
      }
      subscribers.get(propertyId).add(callback);
      return () => {
        const set = subscribers.get(propertyId);
        if (set) {
          set.delete(callback);
          if (set.size === 0) subscribers.delete(propertyId);
        }
      };
    }

    function notify(propertyId, data) {
      const cbs = subscribers.get(propertyId);
      if (cbs) {
        for (const cb of cbs) {
          try {
            cb(data);
          } catch (e) {
            console.error("Vrbow subscriber error:", e);
          }
        }
      }
    }

    async function getCached(propertyId) {
      if (!propertyId || isDisposed) return null;

      // Check in-memory first
      const mem = memoryCache.get(propertyId);
      if (mem && Date.now() - mem.ts < ttlMs) {
        return mem.data;
      }

      // Check persistent storage
      if (storage) {
        return new Promise((resolve) => {
          try {
            storage.get([CACHE_PREFIX + propertyId], (items) => {
              if (isDisposed) {
                resolve(null);
                return;
              }
              const entry = items ? items[CACHE_PREFIX + propertyId] : null;
              if (entry && entry.ts && Date.now() - entry.ts < ttlMs) {
                memoryCache.set(propertyId, { data: entry, ts: entry.ts });
                resolve(entry);
              } else {
                if (entry) {
                  // Expired: prune asynchronously
                  storage.remove([CACHE_PREFIX + propertyId]);
                }
                resolve(null);
              }
            });
          } catch {
            resolve(null);
          }
        });
      }
      return null;
    }

    async function setCached(propertyId, data) {
      if (!propertyId || isDisposed) return;
      const ts = Date.now();
      const entry = { ...data, ts };
      memoryCache.set(propertyId, { data: entry, ts });

      if (storage) {
        try {
          storage.set({ [CACHE_PREFIX + propertyId]: entry });
        } catch (e) {
          console.warn("Vrbow failed to write cache:", e);
        }
      }
    }

    function subscribe(propertyId, callback) {
      if (!subscribers.has(propertyId)) {
        subscribers.set(propertyId, new Set());
      }
      subscribers.get(propertyId).add(callback);
      return () => {
        const set = subscribers.get(propertyId);
        if (set) {
          set.delete(callback);
          if (set.size === 0) subscribers.delete(propertyId);
        }
      };
    }

    async function processQueue() {
      if (isProcessing || isDisposed) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      if (Date.now() < pausedUntil) {
        const remainingPause = pausedUntil - Date.now();
        setTimeout(processQueue, remainingPause + 50);
        return;
      }

      isProcessing = true;
      try {
        while (
          queue.length > 0 &&
          activeRequests.size < maxConcurrent &&
          !isDisposed &&
          (typeof document === "undefined" || document.visibilityState !== "hidden") &&
          Date.now() >= pausedUntil
        ) {
          // Check pacing delay
          const now = Date.now();
          const elapsed = now - lastRequestStartTime;
          if (elapsed < minDelayMs) {
            const waitTime = minDelayMs - elapsed;
            setTimeout(processQueue, waitTime);
            break;
          }

          // Pick next item: prioritize items in highPriorityIds
          let nextIndex = queue.findIndex((item) => highPriorityIds.has(item.propertyId));
          if (nextIndex === -1) nextIndex = 0;
          const [nextItem] = queue.splice(nextIndex, 1);
          highPriorityIds.delete(nextItem.propertyId);

          // Check session cap
          if (sessionRequestsCount >= sessionCap) {
            enqueuedOrActive.delete(nextItem.propertyId);
            const result = { status: "capped", propertyId: nextItem.propertyId };
            notify(nextItem.propertyId, result);
            continue;
          }

          // Check memory cache once more before firing network
          const cached = memoryCache.get(nextItem.propertyId);
          if (cached && Date.now() - cached.ts < ttlMs) {
            enqueuedOrActive.delete(nextItem.propertyId);
            notify(nextItem.propertyId, cached.data);
            continue;
          }

          // Execute fetch
          sessionRequestsCount++;
          lastRequestStartTime = Date.now();
          activeRequests.add(nextItem.propertyId);
          maxObservedConcurrency = Math.max(maxObservedConcurrency, activeRequests.size);

          executeFetch(nextItem.propertyId, nextItem.url)
            .finally(() => {
              activeRequests.delete(nextItem.propertyId);
              enqueuedOrActive.delete(nextItem.propertyId);
              if (!isDisposed) processQueue();
            });
        }
      } finally {
        isProcessing = false;
      }
    }

    const activeControllers = new Map();
    const requestTimeoutMs = options.requestTimeoutMs || 6000;

    async function executeFetch(propertyId, url) {
      if (isDisposed) return;
      const controller = new AbortController();
      activeControllers.set(propertyId, controller);
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

      try {
        if (!fetchFn) throw new Error("No fetch implementation available");

        const res = await fetchFn(url, {
          signal: controller.signal,
          headers: {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
        });

        if (isDisposed) return;

        if (res.status === 429 || res.status === 403) {
          pausedUntil = Date.now() + pauseOnChallengeMs;
          const result = { status: "rate_limited", propertyId };
          notify(propertyId, result);
          return;
        }

        if (!res.ok) {
          const result = { status: "error", code: res.status, propertyId };
          notify(propertyId, result);
          return;
        }

        const html = await res.text();
        if (isDisposed) return;

        const parsed = parseListingHtml(html, propertyId);

        if (parsed && parsed.isChallenge) {
          pausedUntil = Date.now() + pauseOnChallengeMs;
          const result = { status: "rate_limited", propertyId };
          notify(propertyId, result);
          return;
        }

        const hasConcretePolicy = parsed && parsed.policy && (
          parsed.policy.petsAllowed !== null ||
          parsed.policy.maxDogs !== null ||
          parsed.policy.weightLimit !== null ||
          parsed.policy.fee !== null ||
          parsed.policy.deposit !== null ||
          parsed.policy.approvalRequired !== null ||
          (parsed.policy._raw?.otherNotes && parsed.policy._raw.otherNotes.length > 0)
        );

        if (hasConcretePolicy) {
          const data = {
            status: "ok",
            propertyId,
            policy: parsed.policy,
            ts: Date.now(),
          };
          await setCached(propertyId, data);
          notify(propertyId, data);
        } else {
          const result = {
            status: "unknown",
            propertyId,
            policy: null,
          };
          notify(propertyId, result);
        }
      } catch (err) {
        if (isDisposed) return;
        if (err.name === "AbortError") {
          // Stalled request timed out: emit terminal timeout result (never cached)
          const result = { status: "timeout", propertyId };
          notify(propertyId, result);
          return;
        }
        const result = { status: "error", error: err.message, propertyId };
        notify(propertyId, result);
      } finally {
        clearTimeout(timer);
        activeControllers.delete(propertyId);
      }
    }

    function enqueue(propertyId, url, priority = "normal") {
      if (!propertyId || !url || isDisposed) return;

      // 1. Check memory cache synchronously
      const mem = memoryCache.get(propertyId);
      if (mem && Date.now() - mem.ts < ttlMs) {
        notify(propertyId, mem.data);
        return;
      }

      // 2. Synchronous duplicate check to prevent race conditions
      if (enqueuedOrActive.has(propertyId)) {
        if (priority === "high") {
          const item = queue.find((q) => q.propertyId === propertyId);
          if (item) item.priority = "high";
        }
        return;
      }
      enqueuedOrActive.add(propertyId);

      // 3. Check storage cache
      getCached(propertyId).then((cached) => {
        if (isDisposed) return;
        if (cached) {
          enqueuedOrActive.delete(propertyId);
          notify(propertyId, cached);
          return;
        }

        queue.push({ propertyId, url, priority });
        processQueue();
      });
    }

    function clearQueue() {
      queue.length = 0;
      enqueuedOrActive.clear();
      sessionRequestsCount = 0;
    }

    function onVisibilityChange() {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        processQueue();
      }
    }

    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    function dispose() {
      isDisposed = true;
      clearQueue();
      for (const ctrl of activeControllers.values()) {
        try { ctrl.abort(); } catch {}
      }
      activeControllers.clear();
      if (pauseTimer) {
        clearTimeout(pauseTimer);
        pauseTimer = null;
      }
      if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      subscribers.clear();
      memoryCache.clear();
    }

    return {
      getCached,
      setCached,
      enqueue,
      clearQueue,
      dispose,
      subscribe,
      getQueueLength: () => queue.length,
      getActiveCount: () => activeRequests.size,
      getSessionCount: () => sessionRequestsCount,
      getMaxObservedConcurrency: () => maxObservedConcurrency,
      isPaused: () => Date.now() < pausedUntil,
    };
  }

  return {
    walkApolloNode,
    parseListingHtml,
    createSearchFetchQueue,
  };
});
