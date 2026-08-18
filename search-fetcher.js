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
    const policy = extract.extractPolicy(corpus);
    if (!policy || !policy.found) return null;
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
    const enqueuedOrActive = new Set(); // Synchronous tracking to prevent duplicate enqueue races
    const listeners = new Map(); // propertyId -> Set of callbacks

    let isProcessing = false;
    let lastRequestStartTime = 0;
    let sessionRequestsCount = 0;
    let pausedUntil = 0;
    let maxObservedConcurrency = 0;
    let pauseTimer = null;
    let isDisposed = false;

    function getCacheKey(propertyId) {
      return `${CACHE_PREFIX}${propertyId}`;
    }

    async function getCached(propertyId) {
      if (!propertyId || isDisposed) return null;

      // 1. Check memory cache
      const mem = memoryCache.get(propertyId);
      if (mem) {
        if (Date.now() - mem.ts < ttlMs) return mem.data;
        memoryCache.delete(propertyId);
      }

      // 2. Check storage
      if (storage) {
        return new Promise((resolve) => {
          const key = getCacheKey(propertyId);
          storage.get([key], (res) => {
            if (isDisposed) {
              resolve(null);
              return;
            }
            const entry = res ? res[key] : null;
            if (entry && entry.version === CACHE_VERSION && (Date.now() - entry.ts < ttlMs)) {
              memoryCache.set(propertyId, { data: entry.data, ts: entry.ts });
              resolve(entry.data);
            } else {
              if (entry) {
                storage.remove([key], () => {});
              }
              resolve(null);
            }
          });
        });
      }
      return null;
    }

    async function setCached(propertyId, data) {
      if (!propertyId || isDisposed) return;
      const now = Date.now();
      memoryCache.set(propertyId, { data, ts: now });
      if (storage) {
        const key = getCacheKey(propertyId);
        storage.set({
          [key]: {
            version: CACHE_VERSION,
            propertyId,
            data,
            ts: now,
          },
        });
      }
    }

    function subscribe(propertyId, callback) {
      if (!listeners.has(propertyId)) {
        listeners.set(propertyId, new Set());
      }
      listeners.get(propertyId).add(callback);
      return () => {
        const set = listeners.get(propertyId);
        if (set) {
          set.delete(callback);
          if (set.size === 0) listeners.delete(propertyId);
        }
      };
    }

    function notify(propertyId, result) {
      if (isDisposed) return;
      const set = listeners.get(propertyId);
      if (set) {
        for (const cb of set) {
          try {
            cb(result);
          } catch (err) {
            console.error("[Vrbow] Error in listener:", err);
          }
        }
      }
    }

    async function processQueue() {
      if (isProcessing || isDisposed) return;
      isProcessing = true;

      try {
        while (queue.length > 0 && activeRequests.size < maxConcurrent && !isDisposed) {
          const now = Date.now();
          if (now < pausedUntil) {
            if (pauseTimer) clearTimeout(pauseTimer);
            pauseTimer = setTimeout(processQueue, Math.max(20, pausedUntil - now));
            break;
          }

          // Check if tab is hidden
          if (typeof document !== "undefined" && document.visibilityState === "hidden") {
            break;
          }

          // Sort queue: high priority items first
          queue.sort((a, b) => (b.priority === "high" ? 1 : 0) - (a.priority === "high" ? 1 : 0));

          const item = queue.shift();
          if (!item) break;

          const { propertyId, url, priority } = item;

          // Check session budget cap unless it's high priority (user hover)
          if (priority !== "high" && sessionRequestsCount >= sessionCap) {
            enqueuedOrActive.delete(propertyId);
            notify(propertyId, { status: "capped", propertyId });
            continue;
          }

          // Respect minimum delay between requests
          const elapsed = Date.now() - lastRequestStartTime;
          if (elapsed < minDelayMs) {
            await new Promise((r) => setTimeout(r, minDelayMs - elapsed));
            if (isDisposed) break;
            // Re-check pause condition after waiting
            if (Date.now() < pausedUntil) {
              queue.unshift(item);
              if (pauseTimer) clearTimeout(pauseTimer);
              pauseTimer = setTimeout(processQueue, Math.max(20, pausedUntil - Date.now()));
              break;
            }
          }

          lastRequestStartTime = Date.now();
          sessionRequestsCount++;
          activeRequests.add(propertyId);
          maxObservedConcurrency = Math.max(maxObservedConcurrency, activeRequests.size);

          executeFetch(propertyId, url)
            .catch(() => {})
            .finally(() => {
              activeRequests.delete(propertyId);
              enqueuedOrActive.delete(propertyId);
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
          parsed.policy.weightPerDog !== null ||
          parsed.policy.fee !== null ||
          parsed.policy.deposit !== null ||
          parsed.policy.preReg !== null ||
          (parsed.policy.otherNotes && parsed.policy.otherNotes.length > 0)
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
      listeners.clear();
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
