// search-fetcher.js
// Throttled background queue and persistent cache for search result pet policies.

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./extract.js"));
  } else {
    root.VdpSearchFetcher = factory(root.VdpExtract);
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
   * Walk Apollo graph with full __ref pointer resolution.
   */
  function walkApolloNode(state, node, out, seen = new Set(), depth = 0) {
    if (!node || depth > 18) return;
    if (typeof node === "object") {
      if (seen.has(node)) return;
      seen.add(node);
    }

    if (node && typeof node === "object" && typeof node.__ref === "string") {
      const target = state[node.__ref];
      if (target) walkApolloNode(state, target, out, seen, depth + 1);
      return;
    }

    if (Array.isArray(node)) {
      for (const el of node) walkApolloNode(state, el, out, seen, depth + 1);
      return;
    }

    if (node && typeof node === "object") {
      if (node.text && typeof node.text === "string") {
        out.push({
          header: node.header || "Listing Data",
          section: node.section || "Rules",
          text: node.text,
        });
      }
      for (const k of Object.keys(node)) {
        walkApolloNode(state, node[k], out, seen, depth + 1);
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
          walkApolloNode(state, root, items);
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
    const policy = extract.extractPolicy(corpus);
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

    function getCacheKey(propertyId) {
      return `${CACHE_PREFIX}${propertyId}`;
    }

    async function getCached(propertyId) {
      if (!propertyId) return null;

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
            const entry = res ? res[key] : null;
            if (entry && entry.version === CACHE_VERSION && (Date.now() - entry.ts < ttlMs)) {
              memoryCache.set(propertyId, { data: entry.data, ts: entry.ts });
              resolve(entry.data);
            } else {
              if (entry) {
                // Delete expired or version-mismatched data
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
      if (!propertyId) return;
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
      if (isProcessing) return;
      isProcessing = true;

      try {
        while (queue.length > 0 && activeRequests.size < maxConcurrent) {
          // Check if paused due to 429 or challenge
          const now = Date.now();
          if (now < pausedUntil) {
            setTimeout(processQueue, Math.max(50, pausedUntil - now));
            break;
          }

          // Check if tab is hidden (browser environment)
          if (typeof document !== "undefined" && document.visibilityState === "hidden") {
            break;
          }

          // Sort queue: high priority items first
          queue.sort((a, b) => (b.priority === "high" ? 1 : 0) - (a.priority === "high" ? 1 : 0));

          const item = queue.shift();
          if (!item) break;

          const { propertyId, url, priority } = item;

          // Check session budget cap unless it's a high priority hover
          if (priority !== "high" && sessionRequestsCount >= sessionCap) {
            enqueuedOrActive.delete(propertyId);
            notify(propertyId, { status: "capped", propertyId });
            continue;
          }

          // Respect minimum start delay between requests
          const elapsed = Date.now() - lastRequestStartTime;
          if (elapsed < minDelayMs) {
            await new Promise((r) => setTimeout(r, minDelayMs - elapsed));
            // Re-check pause state after waiting
            if (Date.now() < pausedUntil) {
              queue.unshift(item); // Put item back
              setTimeout(processQueue, Math.max(50, pausedUntil - Date.now()));
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
              processQueue();
            });
        }
      } finally {
        isProcessing = false;
      }
    }

    async function executeFetch(propertyId, url) {
      try {
        if (!fetchFn) throw new Error("No fetch implementation available");

        const res = await fetchFn(url, {
          headers: {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
        });

        if (res.status === 429 || res.status === 403) {
          pausedUntil = Date.now() + PAUSE_ON_CHALLENGE_MS;
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
        const parsed = parseListingHtml(html, propertyId);

        if (parsed && parsed.isChallenge) {
          pausedUntil = Date.now() + PAUSE_ON_CHALLENGE_MS;
          const result = { status: "rate_limited", propertyId };
          notify(propertyId, result);
          return;
        }

        if (parsed && parsed.policy) {
          const data = {
            status: "ok",
            propertyId,
            policy: parsed.policy,
            ts: Date.now(),
          };
          await setCached(propertyId, data);
          notify(propertyId, data);
        } else {
          const data = {
            status: "unknown",
            propertyId,
            policy: null,
            ts: Date.now(),
          };
          await setCached(propertyId, data);
          notify(propertyId, data);
        }
      } catch (err) {
        const result = { status: "error", error: err.message, propertyId };
        notify(propertyId, result);
      }
    }

    function enqueue(propertyId, url, priority = "normal") {
      if (!propertyId || !url) return;

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
    }

    return {
      getCached,
      setCached,
      enqueue,
      clearQueue,
      subscribe,
      getQueueLength: () => queue.length,
      getActiveCount: () => activeRequests.size,
      getSessionCount: () => sessionRequestsCount,
      getMaxObservedConcurrency: () => maxObservedConcurrency,
      isPaused: () => Date.now() < pausedUntil,
    };
  }

  return {
    parseListingHtml,
    createSearchFetchQueue,
  };
});
