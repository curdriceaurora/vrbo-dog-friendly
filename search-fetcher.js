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
   * Parse raw listing HTML into an extract.js-compatible corpus.
   * Looks for Apollo state JSON, PropertyInfo snippets, or House Rules sections.
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
        const root = state[targetKey];
        if (root) {
          // Walk Apollo graph if available
          const walk = (node, seen = new Set()) => {
            if (!node || typeof node !== "object" || seen.has(node)) return;
            seen.add(node);
            if (node.text && typeof node.text === "string") {
              items.push({ header: node.header || "Listing Data", section: node.section || "Rules", text: node.text });
            }
            for (const key of Object.keys(node)) {
              walk(node[key], seen);
            }
          };
          walk(root);
        }
      } catch {
        // Fall back to text parsing if JSON parse fails
      }
    }

    // 2. Extract visible text sections from raw HTML (strip markup)
    if (items.length === 0) {
      // Find sections discussing pets, house rules, or amenities
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
    const queue = []; // [{ propertyId, url, priority, resolve, reject }]
    const activeRequests = new Set();
    const listeners = new Map(); // propertyId -> [callbacks]

    let isProcessing = false;
    let lastRequestStartTime = 0;
    let sessionRequestsCount = 0;
    let pausedUntil = 0;

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
            setTimeout(processQueue, pausedUntil - now);
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

          // Check if already fetched while in queue
          const cached = await getCached(propertyId);
          if (cached) {
            notify(propertyId, cached);
            continue;
          }

          // Check session budget cap unless it's a high priority hover
          if (priority !== "high" && sessionRequestsCount >= sessionCap) {
            notify(propertyId, { status: "capped" });
            continue;
          }

          // Respect minimum start delay between requests
          const elapsed = Date.now() - lastRequestStartTime;
          if (elapsed < minDelayMs) {
            await new Promise((r) => setTimeout(r, minDelayMs - elapsed));
          }

          lastRequestStartTime = Date.now();
          sessionRequestsCount++;
          activeRequests.add(propertyId);

          executeFetch(propertyId, url)
            .catch(() => {})
            .finally(() => {
              activeRequests.delete(propertyId);
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
          // Rate limited: pause queue
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

      // If already in memory or storage, notify immediately
      getCached(propertyId).then((cached) => {
        if (cached) {
          notify(propertyId, cached);
          return;
        }

        // Avoid duplicate queue entries
        const existing = queue.find((q) => q.propertyId === propertyId);
        if (existing) {
          if (priority === "high") existing.priority = "high";
        } else if (!activeRequests.has(propertyId)) {
          queue.push({ propertyId, url, priority });
        }

        processQueue();
      });
    }

    function clearQueue() {
      queue.length = 0;
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
      isPaused: () => Date.now() < pausedUntil,
    };
  }

  return {
    parseListingHtml,
    createSearchFetchQueue,
  };
});
