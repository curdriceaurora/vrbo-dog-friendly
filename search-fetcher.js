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
  const CACHE_RECORD_VERSION = 1;
  const POLICY_SCHEMA_VERSION = 1;
  const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  const DEFAULT_CONCURRENCY = 2;
  const DEFAULT_MIN_DELAY_MS = 400;
  const DEFAULT_SESSION_CAP = 40;
  const PAUSE_ON_CHALLENGE_MS = 30000; // 30s backoff if 429 or challenge encountered
  const DEFAULT_COOLDOWN_MS = 30000; // 30s cooldown for terminal states

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
   * A "concrete" canonical policy is one a badge can actually show — not a
   * null policy and not one whose every field is "not specified".
   */
  function hasConcretePolicy(policy) {
    return Boolean(policy && (
      policy.petsAllowed !== null ||
      policy.maxDogs !== null ||
      policy.weightLimit !== null ||
      policy.fee !== null ||
      policy.deposit !== null ||
      policy.approvalRequired !== null ||
      (policy._raw?.otherNotes && policy._raw.otherNotes.length > 0)
    ));
  }

  /**
   * Build a concrete canonical policy from a search-page Apollo record
   * (a bridge result of { propertyId, items }). Returns null when the
   * record is empty or yields nothing concrete — callers then fall
   * through to a normal listing fetch.
   */
  function resolveSearchApolloRecord(record, propertyId, source = "search-page-state") {
    if (!record || !Array.isArray(record.items) || record.items.length === 0) return null;
    const corpus = extract.buildCorpus({ items: record.items }, []);
    if (!corpus || corpus.length === 0) return null;
    const rawPolicy = extract.extractPolicy(corpus);
    if (!rawPolicy || !rawPolicy.found) return null;
    const policy = typeof extract.normalizePolicy === "function"
      ? extract.normalizePolicy(rawPolicy, propertyId, source)
      : rawPolicy;
    return hasConcretePolicy(policy) ? policy : null;
  }

  /**
   * Calculate a numeric completeness score for a policy based on concrete fields.
   */
  function calculatePolicyCompleteness(policy) {
    if (!policy) return 0;
    let score = 0;
    if (policy.petsAllowed !== null && policy.petsAllowed !== undefined) score += 2;
    if (policy.maxDogs !== null && policy.maxDogs !== undefined) score += 2;
    if (policy.weightLimit && policy.weightLimit.value !== null) score += 2;
    if (policy.fee && policy.fee.amount !== null) score += 2;
    if (policy.deposit && policy.deposit.amount !== null) score += 1;
    if (policy.approvalRequired !== null && policy.approvalRequired !== undefined) score += 1;
    if (policy.restrictionsFound) score += 1;
    return score;
  }

  /**
   * Enforces data quality precedence:
   * valid detailed cache > detailed listing > detailed Apollo > shallow Apollo > unknown.
   */
  function canPolicyUpgrade(existingPolicy, newPolicy, newSource) {
    if (!existingPolicy) return true;
    if (!newPolicy) return false;

    const existingScore = calculatePolicyCompleteness(existingPolicy);
    const newScore = calculatePolicyCompleteness(newPolicy);

    // If new is strictly more complete, allow upgrade
    if (newScore > existingScore) return true;
    // If existing is strictly more complete, prevent downgrade
    if (existingScore > newScore) return false;

    // If scores are equal, prefer direct listing fetch over search Apollo state
    const sourcePriority = { "listing-page": 3, "search-response": 2, "search-page-state": 1 };
    const existingPri = sourcePriority[existingPolicy.source] || 0;
    const newPri = sourcePriority[newSource || newPolicy.source] || 0;

    return newPri >= existingPri;
  }

  /**
   * Strict persistence serializer that allowlists canonical schema fields
   * and strips unneeded _raw objects, snippets, and DOM text from storage.
   */
  function serializeSearchPolicyForCache(policy) {
    if (!policy || typeof policy !== "object") return null;
    return {
      schemaVersion: POLICY_SCHEMA_VERSION,
      propertyId: policy.propertyId || null,
      source: policy.source || "search-response",
      extractedAt: policy.extractedAt || new Date().toISOString(),
      petsAllowed: policy.petsAllowed !== undefined ? policy.petsAllowed : null,
      maxDogs: policy.maxDogs !== undefined ? policy.maxDogs : null,
      weightLimit: policy.weightLimit ? {
        value: policy.weightLimit.value,
        unit: policy.weightLimit.unit,
        ...(policy.weightLimit.pounds !== undefined ? { pounds: policy.weightLimit.pounds } : {}),
      } : null,
      fee: policy.fee ? {
        amount: policy.fee.amount,
        currency: policy.fee.currency,
        period: policy.fee.period,
        ...(policy.fee.perPet ? { perPet: true } : {}),
      } : null,
      deposit: policy.deposit ? {
        amount: policy.deposit.amount,
        currency: policy.deposit.currency,
      } : null,
      approvalRequired: policy.approvalRequired !== undefined ? policy.approvalRequired : null,
      restrictionsFound: Boolean(policy.restrictionsFound),
      confidence: policy.confidence || "low",
    };
  }

  /**
   * Search Fetch Queue & Cache Manager
   */
  function createSearchFetchQueue(options = {}) {
    const fetchFn = options.fetchFn || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
    const storage = options.storage || (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local ? chrome.storage.local : null);
    const maxConcurrent = options.maxConcurrent !== undefined ? options.maxConcurrent : DEFAULT_CONCURRENCY;
    const minDelayMs = options.minDelayMs !== undefined ? options.minDelayMs : DEFAULT_MIN_DELAY_MS;
    const sessionCap = options.sessionCap !== undefined ? options.sessionCap : DEFAULT_SESSION_CAP;
    const ttlMs = options.ttlMs !== undefined ? options.ttlMs : DEFAULT_TTL_MS;
    const pauseOnChallengeMs = options.pauseOnChallengeMs !== undefined ? options.pauseOnChallengeMs : PAUSE_ON_CHALLENGE_MS;
    const cooldownMs = options.cooldownMs !== undefined ? options.cooldownMs : DEFAULT_COOLDOWN_MS;

    const memoryCache = new Map();
    const terminalCooldowns = new Map(); // propertyId -> { data, expiresAt, allowBypass }
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
    const scheduledTimers = new Set();

    if (storage && options.autoMaintenance !== false) {
      performStorageMaintenance(storage).catch(() => {});
    }

    function scheduleTimer(fn, ms) {
      if (isDisposed) return null;
      const timer = setTimeout(() => {
        scheduledTimers.delete(timer);
        if (!isDisposed) fn();
      }, ms);
      scheduledTimers.add(timer);
      return timer;
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

    function recordTerminalState(propertyId, data, allowBypass = false) {
      if (!propertyId || isDisposed) return;
      terminalCooldowns.set(propertyId, {
        data,
        expiresAt: Date.now() + cooldownMs,
        allowBypass,
      });
    }

    async function getCached(propertyId) {
      if (!propertyId || isDisposed) return null;

      // Check in-memory ok cache first
      const mem = memoryCache.get(propertyId);
      if (mem && Date.now() - mem.ts < ttlMs) {
        return mem.data;
      }

      // Check terminal-state cooldown cache in memory
      const terminal = terminalCooldowns.get(propertyId);
      if (terminal) {
        if (Date.now() < terminal.expiresAt) {
          return terminal.data;
        }
        terminalCooldowns.delete(propertyId);
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
              if (
                entry &&
                entry.cacheVersion === CACHE_RECORD_VERSION &&
                entry.propertyId === propertyId &&
                entry.expiresAt &&
                Date.now() < entry.expiresAt &&
                entry.data?.policy?.schemaVersion === POLICY_SCHEMA_VERSION
              ) {
                memoryCache.set(propertyId, { data: entry.data, ts: entry.storedAt || Date.now() });
                resolve(entry.data);
              } else {
                if (entry) {
                  // Incompatible or expired: prune asynchronously
                  try { storage.remove([CACHE_PREFIX + propertyId], () => {}); } catch {}
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
      if (!propertyId || isDisposed || !data) return;

      // Check precedence against existing cache to prevent downgrading richer data
      const existing = await getCached(propertyId);
      if (existing && existing.policy && data.policy) {
        if (!canPolicyUpgrade(existing.policy, data.policy, data.source || data.policy.source)) {
          return;
        }
      }

      // Serialize policy with field allowlist (strips _raw, snippets, etc.)
      const persistentPolicy = serializeSearchPolicyForCache(data.policy);
      const persistentData = {
        ...data,
        policy: persistentPolicy || data.policy,
      };

      const storedAt = Date.now();
      const expiresAt = storedAt + ttlMs;
      const entry = {
        cacheVersion: CACHE_RECORD_VERSION,
        propertyId,
        storedAt,
        expiresAt,
        data: persistentData,
      };
      memoryCache.set(propertyId, { data: persistentData, ts: storedAt });

      if (storage) {
        try {
          storage.set({ [CACHE_PREFIX + propertyId]: entry }, () => {});
        } catch (e) {
          console.warn("Vrbow failed to write cache:", e);
        }
      }
    }

    async function processQueue() {
      if (isProcessing || isDisposed) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      if (Date.now() < pausedUntil) {
        const remainingPause = pausedUntil - Date.now();
        scheduleTimer(processQueue, remainingPause + 50);
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
            scheduleTimer(processQueue, waitTime);
            break;
          }

          // Pick next item: prioritize items in highPriorityIds or marked priority: "high"
          let nextIndex = queue.findIndex((item) => item.priority === "high" || highPriorityIds.has(item.propertyId));
          if (nextIndex === -1) nextIndex = 0;
          const [nextItem] = queue.splice(nextIndex, 1);
          const isHighPriority = nextItem.priority === "high" || highPriorityIds.has(nextItem.propertyId);
          highPriorityIds.delete(nextItem.propertyId);

          // Check session cap: background requests are capped; explicit user hover (priority: "high") bypasses the background cap
          if (!isHighPriority && sessionRequestsCount >= sessionCap) {
            enqueuedOrActive.delete(nextItem.propertyId);
            const result = { status: "capped", propertyId: nextItem.propertyId };
            recordTerminalState(nextItem.propertyId, result, true);
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
          recordTerminalState(propertyId, result, false);
          notify(propertyId, result);
          return;
        }

        if (!res.ok) {
          const result = { status: "error", code: res.status, propertyId };
          recordTerminalState(propertyId, result, false);
          notify(propertyId, result);
          return;
        }

        const html = await res.text();
        if (isDisposed) return;

        const parsed = parseListingHtml(html, propertyId);

        if (parsed && parsed.isChallenge) {
          pausedUntil = Date.now() + pauseOnChallengeMs;
          const result = { status: "rate_limited", propertyId };
          recordTerminalState(propertyId, result, false);
          notify(propertyId, result);
          return;
        }

        const hasConcrete = hasConcretePolicy(parsed && parsed.policy);

        if (hasConcrete) {
          const data = {
            status: "ok",
            propertyId,
            policy: parsed.policy,
            ts: Date.now(),
          };
          terminalCooldowns.delete(propertyId);
          await setCached(propertyId, data);
          notify(propertyId, data);
        } else {
          const result = {
            status: "unknown",
            propertyId,
            policy: null,
          };
          recordTerminalState(propertyId, result, false);
          notify(propertyId, result);
        }
      } catch (err) {
        if (isDisposed) return;
        if (err.name === "AbortError") {
          // Stalled request timed out: emit terminal timeout result (never cached)
          const result = { status: "timeout", propertyId };
          recordTerminalState(propertyId, result, false);
          notify(propertyId, result);
          return;
        }
        const result = { status: "error", error: err.message, propertyId };
        recordTerminalState(propertyId, result, false);
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

      // 2. Check terminal-state cooldown
      const terminal = terminalCooldowns.get(propertyId);
      if (terminal) {
        if (Date.now() < terminal.expiresAt) {
          // If high priority and bypass is allowed (e.g. background-capped property receiving its 1 explicit attempt)
          if (priority === "high" && terminal.allowBypass) {
            terminalCooldowns.delete(propertyId);
            // proceed to enqueue attempt
          } else {
            notify(propertyId, terminal.data);
            return;
          }
        } else {
          terminalCooldowns.delete(propertyId);
        }
      }

      // 3. Synchronous duplicate check to prevent race conditions
      if (enqueuedOrActive.has(propertyId)) {
        if (priority === "high") {
          highPriorityIds.add(propertyId);
          const item = queue.find((q) => q.propertyId === propertyId);
          if (item) item.priority = "high";
        }
        return;
      }
      if (priority === "high") {
        highPriorityIds.add(propertyId);
      }
      enqueuedOrActive.add(propertyId);

      // 4. Check storage cache
      getCached(propertyId).then((cached) => {
        if (isDisposed) return;
        if (cached && cached.status === "ok") {
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
      highPriorityIds.clear();
      sessionRequestsCount = 0;
      terminalCooldowns.clear();
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
      for (const t of scheduledTimers) {
        clearTimeout(t);
      }
      scheduledTimers.clear();
      if (pauseTimer) {
        clearTimeout(pauseTimer);
        pauseTimer = null;
      }
      if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      subscribers.clear();
      memoryCache.clear();
      terminalCooldowns.clear();
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
      isInCooldown: (propertyId) => {
        const t = terminalCooldowns.get(propertyId);
        return Boolean(t && Date.now() < t.expiresAt && !t.allowBypass);
      },
    };
  }

  /**
   * 8.2.7 Bounded Storage Maintenance:
   * Remove stale, expired, or incompatible Vrbow cache keys from storage.
   * Sweeps only keys with the vrbow_cache_ prefix.
   * Records no analytics.
   */
  async function performStorageMaintenance(storage, options = {}) {
    if (!storage || typeof storage.get !== "function") {
      return { inspected: 0, removed: 0, removedKeys: [] };
    }
    const now = typeof options.now === "number" ? options.now : Date.now();

    return new Promise((resolve) => {
      try {
        storage.get(null, (allItems) => {
          if (!allItems || typeof allItems !== "object") {
            resolve({ inspected: 0, removed: 0, removedKeys: [] });
            return;
          }

          const keysToRemove = [];
          let inspected = 0;

          for (const [key, entry] of Object.entries(allItems)) {
            // Sweep only keys with the vrbow_cache_ prefix
            if (!key.startsWith(CACHE_PREFIX)) {
              continue;
            }

            inspected++;

            // Check if record is corrupt, incompatible, or expired
            const isCorrupt = !entry || typeof entry !== "object";
            const isIncompatible = !isCorrupt && (
              entry.cacheVersion !== CACHE_RECORD_VERSION ||
              !entry.data ||
              typeof entry.data !== "object" ||
              !entry.data.policy ||
              entry.data.policy.schemaVersion !== POLICY_SCHEMA_VERSION
            );
            const isExpired = !isCorrupt && (
              !entry.expiresAt ||
              now >= entry.expiresAt
            );

            if (isCorrupt || isIncompatible || isExpired) {
              keysToRemove.push(key);
            }
          }

          if (keysToRemove.length > 0 && typeof storage.remove === "function") {
            try {
              storage.remove(keysToRemove, () => {
                resolve({ inspected, removed: keysToRemove.length, removedKeys: keysToRemove });
              });
            } catch {
              resolve({ inspected, removed: 0, removedKeys: [] });
            }
          } else {
            resolve({ inspected, removed: 0, removedKeys: [] });
          }
        });
      } catch {
        resolve({ inspected: 0, removed: 0, removedKeys: [] });
      }
    });
  }

  /**
   * Validate and separate a Vrbo listing URL into a clean canonical fetch URL
   * (HTTPS, www.vrbo.com or vrbo.com, pathname only, no query or fragment)
   * and the original navigation URL.
   */
  function validateListingUrl(urlStr, baseUrl = "https://www.vrbo.com") {
    if (!urlStr || typeof urlStr !== "string") return null;
    try {
      const u = new URL(urlStr, baseUrl);
      if (u.protocol !== "https:") return null;
      if (!/^(www\.)?vrbo\.com$/i.test(u.hostname)) return null;

      // Extract property ID from pathname
      const m = /(?:\/pdp(?:\/lo)?\/|\/vacation-rentals?(?:\/p)?\/p?|\/)(p?\d+[a-z0-9]*)(?:\/|\?|$)/i.exec(u.pathname);
      if (!m) return null;
      let propId = m[1];
      if (/^p\d+/i.test(propId)) propId = propId.slice(1);
      if (!propId) return null;

      // Make sure the path matches a listing format
      if (
        !/^\/\d+[a-z0-9]*\/?$/i.test(u.pathname) &&
        !/^\/pdp(\/lo)?\/\d+[a-z0-9]*\/?$/i.test(u.pathname) &&
        !/^\/vacation-rentals?(\/p)?\/?p?\d+[a-z0-9]*\/?$/i.test(u.pathname)
      ) {
        return null;
      }

      const navigationUrl = u.href;
      const fetchUrl = `https://www.vrbo.com${u.pathname}`;

      return {
        propertyId: propId,
        navigationUrl,
        fetchUrl,
      };
    } catch {
      return null;
    }
  }

  return {
    CACHE_PREFIX,
    walkApolloNode,
    parseListingHtml,
    hasConcretePolicy,
    resolveSearchApolloRecord,
    createSearchFetchQueue,
    validateListingUrl,
    performStorageMaintenance,
    calculatePolicyCompleteness,
    canPolicyUpgrade,
    serializeSearchPolicyForCache,
  };
});

