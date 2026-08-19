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
  const ALIAS_PREFIX = "vrbow_alias_";
  const CACHE_RECORD_VERSION = 1;
  const POLICY_SCHEMA_VERSION = 1;
  const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  const DEFAULT_CONCURRENCY = 2;
  // Base of the adaptive delay ladder (I10). effectiveMinDelayMs = baseDelayMs * 2 ** ladderStep,
  // so background pacing walks 800 -> 1600 -> 3200 ms.
  const DEFAULT_MIN_DELAY_MS = 800;
  // Global dispatch floor applied to EVERY dispatch regardless of class, high priority
  // included. Scales on the same shared ladder: 250 -> 500 -> 1000 ms.
  const HIGH_PRIORITY_FLOOR_MS = 250;
  // ladderStep saturates here: 800 * 2 ** 2 = 3200 ms. There is no step 3.
  const MAX_LADDER_STEP = 2;
  // One-sided jitter: +[0, 30%] of the resolved wait, never below the floor. A symmetric
  // +/- jitter would permit firing faster than the rate limit it is meant to enforce.
  const DELAY_JITTER_RATIO = 0.3;
  // Timeouts / 5xx only escalate after a small cluster, so one noisy timeout does not throttle.
  const DEFAULT_ERROR_CLUSTER_THRESHOLD = 3;
  const DEFAULT_ERROR_CLUSTER_WINDOW_MS = 60000;
  // Recovery is deliberately asymmetric: one success never steps down, a sustained
  // clean window (zero non-successes) does.
  const DEFAULT_CLEAN_WINDOW_MS = 60000;
  const DEFAULT_SESSION_CAP = 40;
  const PAUSE_ON_CHALLENGE_MS = 30000; // 30s backoff if 429 or challenge encountered
  const DEFAULT_COOLDOWN_MS = 30000; // 30s cooldown for terminal states

  /**
   * Walk Apollo graph with full __ref pointer resolution and support for header.text and value/text leaves.
   * Delegates to shared pure extractor in extract.js.
   */
  function walkApolloNode(state, node, headerCtx, sectionCtx, out, visited, depth, isExplicitPetContext) {
    if (extract && typeof extract.walkApolloNode === "function") {
      return extract.walkApolloNode(state, node, headerCtx, sectionCtx, out, visited, depth, isExplicitPetContext);
    }
    if (typeof console !== "undefined" && typeof console.warn === "function") {
      console.warn("[vrbow] extract.walkApolloNode is unavailable; check script load order");
    }
  }

  /**
   * Parse raw listing HTML into an extract.js-compatible corpus.
   * Resolves Apollo state JSON with __ref references or extracts from HTML sections.
   */
  function parseListingHtml(html, propertyId, canonicalId) {
    if (!html || typeof html !== "string") return null;

    // Check for bot challenges or error pages
    if (/challenge-running|bot or not|cf-browser-verification|captcha/i.test(html)) {
      return { isChallenge: true };
    }

    const items = [];
    let detectedAliases = [];

    // 1. Check for embedded Apollo state in <script> tags
    let state = null;

    // Pattern A: window.__APOLLO_STATE__ = JSON.parse("...");
    const idx = html.indexOf("window.__APOLLO_STATE__");
    if (idx !== -1) {
      const endScriptIdx = html.indexOf("</script>", idx);
      const slice = endScriptIdx !== -1 ? html.slice(idx, endScriptIdx) : html.slice(idx, idx + 5000000);
      
      const jsonParseMatch = /window\.__APOLLO_STATE__\s*=\s*JSON\.parse\((["'])([\s\S]+?)\1\s*\);/.exec(slice);
      if (jsonParseMatch) {
        const rawQuoted = jsonParseMatch[0].slice(jsonParseMatch[0].indexOf("(") + 1, jsonParseMatch[0].lastIndexOf(")"));
        try {
          const jsonStr = JSON.parse(rawQuoted);
          state = JSON.parse(jsonStr);
        } catch {}
      }

      if (!state) {
        const directObjMatch = /window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]+?\});\s*(?:<\/script>|\n|$)/.exec(slice);
        if (directObjMatch) {
          try {
            state = JSON.parse(directObjMatch[1]);
          } catch {}
        }
      }
    }

    // Pattern B: <script id="__APOLLO_STATE__">...</script>
    if (!state) {
      const tagMatch = /<script[^>]*id="__APOLLO_STATE__"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
      if (tagMatch) {
        try {
          state = JSON.parse(tagMatch[1]);
        } catch {}
      }
    }

    if (state && typeof state === "object") {
      try {
        let targetKey = null;
        const candidateIds = [propertyId, canonicalId].filter(Boolean).map((id) => String(id).toLowerCase());

        for (const cid of candidateIds) {
          targetKey = Object.keys(state).find(
            (k) => k.toLowerCase() === `propertyinfo:${cid}` || k.toLowerCase() === `property:${cid}`
          );
          if (targetKey) break;
        }

        if (!targetKey && candidateIds.length > 0) {
          for (const k of Object.keys(state)) {
            if (!k.startsWith("PropertyInfo:") && !k.startsWith("Property:")) continue;
            const node = state[k];
            if (!node || typeof node !== "object") continue;
            const nodeIds = [node.propertyId, node.vrboPropertyId, node.expediaPropertyId, node.id]
              .filter(Boolean)
              .map((id) => String(id).toLowerCase());
            if (candidateIds.some((cid) => nodeIds.includes(cid))) {
              targetKey = k;
              break;
            }
          }
        }

        if (!targetKey && candidateIds.length === 0) {
          targetKey = Object.keys(state).find((k) => k.startsWith("PropertyInfo:")) ||
                      Object.keys(state).find((k) => k.startsWith("Property:"));
        }

        const root = targetKey ? state[targetKey] : null;
        if (root) {
          if (root.expediaPropertyId) detectedAliases.push(String(root.expediaPropertyId));
          if (root.propertyId) detectedAliases.push(String(root.propertyId));
          if (root.id) detectedAliases.push(String(root.id));

          walkApolloNode(state, root, null, null, items);
        }
      } catch {}
    }

    // 2. Extract visible text sentences from raw HTML (description, house rules, amenities)
    const domSentences = [];
    const cleanHtml = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
      .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, " ")
      .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|li|h[1-6]|tr|td|th|dd|dt|blockquote)>/gi, "\n");

    const rawText = cleanHtml.replace(/<[^>]+>/g, " ");
    const sentences = typeof extract.getSentences === "function"
      ? extract.getSentences(rawText)
      : [];
    const seenSentences = new Set();
    for (const s of sentences) {
      if (typeof extract.isPetRelated === "function" && extract.isPetRelated(s) && !seenSentences.has(s)) {
        seenSentences.add(s);
        domSentences.push({ text: s, source: "About this property" });
      }
    }

    if (items.length === 0 && domSentences.length === 0) return null;

    // Build corpus combining Apollo items and visible HTML sentences
    const corpus = extract.buildCorpus({ items }, domSentences);
    if (!corpus || corpus.length === 0) return null;
    const rawPolicy = extract.extractPolicy(corpus);
    if (!rawPolicy || !rawPolicy.found) return null;
    const effectivePropId = canonicalId || propertyId;
    const policy = typeof extract.normalizePolicy === "function"
      ? extract.normalizePolicy(rawPolicy, effectivePropId, "search-response")
      : rawPolicy;
    return {
      ok: true,
      propertyId: effectivePropId,
      requestedId: propertyId,
      canonicalId,
      aliases: Array.from(new Set(detectedAliases)),
      policy,
      rawItemsCount: items.length + domSentences.length,
    };
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
      (policy.restrictionNoteCount && policy.restrictionNoteCount > 0) ||
      (policy._raw?.otherNotes && policy._raw.otherNotes.length > 0)
    ));
  }

  /**
   * Identifies whether a cached policy is merely a preliminary search-level
   * boolean flag without specific secondary numbers/rules.
   */
  function isShallowPreliminaryPolicy(policy) {
    if (!policy || typeof policy !== "object") return false;
    // Definitive negative policy never needs upgrading
    if (policy.petsAllowed === false) return false;
    // Rich policy with secondary constraints does not need upgrading
    if (policy.maxDogs !== null && policy.maxDogs !== undefined) return false;
    if (policy.weightLimit && policy.weightLimit.value !== null) return false;
    if (policy.fee && policy.fee.amount !== null) return false;
    if (policy.deposit && policy.deposit.amount !== null) return false;
    if (policy.approvalRequired !== null && policy.approvalRequired !== undefined) return false;
    if ((policy.restrictionNoteCount && policy.restrictionNoteCount > 0) || (policy._raw?.otherNotes && policy._raw.otherNotes.length > 0)) return false;

    // Shallow boolean flag from search results state
    return policy.source === "search-page-state" || policy._source === "search-page-state";
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
        ...(policy.fee.text !== undefined ? { text: policy.fee.text } : {}),
        ...(policy.fee.perPet ? { perPet: true } : {}),
        ...(policy.fee.tiered ? { tiered: true } : {}),
      } : null,
      deposit: policy.deposit ? {
        amount: policy.deposit.amount,
        currency: policy.deposit.currency,
        ...(policy.deposit.text !== undefined ? { text: policy.deposit.text } : {}),
      } : null,
      approvalRequired: policy.approvalRequired !== undefined ? policy.approvalRequired : null,
      restrictionsFound: Boolean(policy.restrictionsFound),
      contradictions: policy.contradictions && typeof policy.contradictions === "object" ? {
        maxDogs: Boolean(policy.contradictions.maxDogs),
        weightLimit: Boolean(policy.contradictions.weightLimit),
        fee: Boolean(policy.contradictions.fee),
      } : { maxDogs: false, weightLimit: false, fee: false },
      restrictionNoteCount: typeof policy.restrictionNoteCount === "number" ? policy.restrictionNoteCount : 0,
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
    // minDelayMs IS baseDelayMs: the ladder base, not a separate knob.
    const baseDelayMs = minDelayMs;
    // Global spacing floor: hpFloor = min(HIGH_PRIORITY_FLOOR_MS, baseDelayMs).
    // The clamp is an invariant of the two-tracker design, not a test convenience:
    // lastDispatchAt gates EVERY dispatch, so hpFloor is the aggregate rate limit
    // sitting underneath the per-class background floor. Letting it exceed
    // baseDelayMs would make the "global" floor stricter than the background floor
    // it is supposed to sit under, and background items would then be paced by the
    // high-priority term instead of their own. At production constants the clamp is
    // inert (min(250, 800) = 250); it only binds when baseDelayMs is configured
    // below 250 ms.
    const highPriorityFloorMs = Math.min(
      options.highPriorityFloorMs !== undefined ? options.highPriorityFloorMs : HIGH_PRIORITY_FLOOR_MS,
      baseDelayMs
    );
    const errorClusterThreshold = options.errorClusterThreshold !== undefined
      ? options.errorClusterThreshold
      : DEFAULT_ERROR_CLUSTER_THRESHOLD;
    const errorClusterWindowMs = options.errorClusterWindowMs !== undefined
      ? options.errorClusterWindowMs
      : DEFAULT_ERROR_CLUSTER_WINDOW_MS;
    const cleanWindowMs = options.cleanWindowMs !== undefined
      ? options.cleanWindowMs
      : DEFAULT_CLEAN_WINDOW_MS;
    const randomFn = typeof options.randomFn === "function" ? options.randomFn : Math.random;

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
    // Two trackers, not three. lastDispatchAt is written by every dispatch (both classes),
    // so it is always at least as recent as a dedicated high-priority tracker would be.
    let lastDispatchAt = 0;
    let lastBgStart = 0;
    let ladderStep = 0;
    let lastNonSuccessAt = Date.now();
    const softFailureTimes = [];
    // enqueue() stages a property synchronously but only pushes it to `queue` after an
    // async storage lookup. Tokens let remove() cancel a still-pending push.
    const pendingEnqueues = new Map();
    let enqueueSeq = 0;
    let maxObservedConcurrency = 0;
    let pauseTimer = null;
    let maintenanceIntervalTimer = null;
    const scheduledTimers = new Set();
    const maintenanceIntervalMs = typeof options.maintenanceIntervalMs === "number"
      ? options.maintenanceIntervalMs
      : 24 * 60 * 60 * 1000;

    if (storage && options.autoMaintenance !== false) {
      performStorageMaintenance(storage).catch(() => {});
      if (maintenanceIntervalMs > 0) {
        maintenanceIntervalTimer = setInterval(() => {
          if (!isDisposed && storage) {
            performStorageMaintenance(storage).catch(() => {});
          }
        }, maintenanceIntervalMs);
      }
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

    const aliasMap = new Map();

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
      const targetId = aliasMap.get(String(propertyId).toLowerCase()) || propertyId;

      // Check in-memory ok cache first
      const mem = memoryCache.get(targetId) || memoryCache.get(propertyId);
      if (mem && Date.now() - mem.ts < ttlMs) {
        return mem.data;
      }

      // Check terminal-state cooldown cache in memory
      const terminal = terminalCooldowns.get(targetId) || terminalCooldowns.get(propertyId);
      if (terminal) {
        if (Date.now() < terminal.expiresAt) {
          return terminal.data;
        }
        terminalCooldowns.delete(targetId);
        terminalCooldowns.delete(propertyId);
      }

      // Check persistent storage
      if (storage) {
        return new Promise((resolve) => {
          try {
            storage.get([
              CACHE_PREFIX + targetId,
              CACHE_PREFIX + propertyId,
              ALIAS_PREFIX + propertyId,
            ], (items) => {
              if (isDisposed) {
                resolve(null);
                return;
              }
              const alias = items ? items[ALIAS_PREFIX + propertyId] : null;
              if (alias && typeof alias === "string") {
                aliasMap.set(String(propertyId).toLowerCase(), alias);
              }
              const effectiveId = alias || targetId;
              const entry = items ? (items[CACHE_PREFIX + effectiveId] || items[CACHE_PREFIX + propertyId]) : null;
              if (
                entry &&
                entry.cacheVersion === CACHE_RECORD_VERSION &&
                entry.expiresAt &&
                Date.now() < entry.expiresAt &&
                entry.data?.policy?.schemaVersion === POLICY_SCHEMA_VERSION
              ) {
                memoryCache.set(effectiveId, { data: entry.data, ts: entry.storedAt || Date.now() });
                memoryCache.set(propertyId, { data: entry.data, ts: entry.storedAt || Date.now() });
                resolve(entry.data);
              } else {
                if (entry) {
                  // Incompatible or expired: prune asynchronously
                  try { storage.remove([CACHE_PREFIX + effectiveId, CACHE_PREFIX + propertyId], () => {}); } catch {}
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
      if (!propertyId || isDisposed || !data) return { accepted: false, data: null, policy: null };

      // Check precedence against existing cache to prevent downgrading richer data
      const existing = await getCached(propertyId);
      if (isDisposed) return { accepted: false, data: null, policy: null };

      if (existing && existing.policy && data.policy) {
        if (!canPolicyUpgrade(existing.policy, data.policy, data.source || data.policy.source)) {
          return {
            accepted: false,
            data: existing,
            policy: existing.policy,
          };
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

      return { accepted: true, data: persistentData, policy: persistentData.policy };
    }

    // --- Adaptive delay ladder: one scalar, one counter, one timer -------------
    function effectiveMinDelayMs() {
      return baseDelayMs * Math.pow(2, ladderStep);
    }

    function hpMinDelayMs() {
      return highPriorityFloorMs * Math.pow(2, ladderStep);
    }

    /** One-sided jitter, applied ONCE to an already-resolved wait. */
    function applyJitter(waitMs) {
      if (!(waitMs > 0)) return waitMs;
      return waitMs + randomFn() * DELAY_JITTER_RATIO * waitMs;
    }

    function bumpLadder() {
      if (ladderStep < MAX_LADDER_STEP) ladderStep++;
    }

    /**
     * Restarts the clean window used for recovery. Called only by the two pressure
     * outcomes below (hard block, soft failure). Everything else — `unknown`, 404 and
     * other non-429/403 4xx — is inert on this path as well as on the ladder.
     */
    function noteNonSuccess() {
      lastNonSuccessAt = Date.now();
    }

    /**
     * 429 / 403 / bot challenge. Does exactly two things, once per event:
     * sets the hard 30s pause AND advances the shared ladder. The pause is the
     * immediate stop; the ladder is what makes the resumption slower.
     */
    function noteHardBlock() {
      pausedUntil = Date.now() + pauseOnChallengeMs;
      noteNonSuccess();
      bumpLadder();
    }

    /** Timeout / 5xx / network error: escalates only on a cluster. */
    function noteSoftFailure() {
      const now = Date.now();
      noteNonSuccess();
      softFailureTimes.push(now);
      while (softFailureTimes.length > 0 && now - softFailureTimes[0] > errorClusterWindowMs) {
        softFailureTimes.shift();
      }
      if (softFailureTimes.length >= errorClusterThreshold) {
        softFailureTimes.length = 0; // next escalation needs another full cluster
        bumpLadder();
      }
    }

    /**
     * A concrete-policy success. Steps down only after a sustained clean window.
     *
     * Recovery is success-driven BY DESIGN, not on a timer: a ladder sitting above
     * step 0 with zero traffic does not self-heal, it waits for the next successful
     * fetch. This is intentional. An idle queue issues no requests, so an elevated
     * floor costs nothing while idle, and the first request after an idle stretch is
     * the one that most needs to be careful. Queues do not outlive a page session,
     * so there is no long-lived state to leak.
     */
    function noteSuccess() {
      const now = Date.now();
      if (ladderStep > 0 && now - lastNonSuccessAt >= cleanWindowMs) {
        ladderStep--;
        lastNonSuccessAt = now; // the next step-down needs another full window
      }
    }

    /**
     * wait = max(hpFloor - since(lastDispatchAt), classFloor - since(classStart))
     * Background needs both terms: the global one binds when a hover has just fired,
     * the class one otherwise. High priority only needs the global term, since
     * lastDispatchAt already covers every previous high-priority dispatch.
     */
    function computeDispatchWait(isHighPriority, now) {
      const globalWait = hpMinDelayMs() - (now - lastDispatchAt);
      if (isHighPriority) return Math.max(globalWait, 0);
      const classWait = effectiveMinDelayMs() - (now - lastBgStart);
      return Math.max(globalWait, classWait, 0);
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
          // Peek the next item FIRST: per-class pacing floors cannot be evaluated before
          // the item's class is known, so the gate below runs after the priority pick.
          let nextIndex = queue.findIndex((item) => item.priority === "high" || highPriorityIds.has(item.propertyId));
          const isHighPriority = nextIndex !== -1;
          if (nextIndex === -1) nextIndex = 0;
          const candidate = queue[nextIndex];

          // Resolutions that issue no network request are settled before the pacing gate,
          // so a skipped item never consumes a dispatch slot's worth of delay.

          // Check session cap: background requests are capped; explicit user hover (priority: "high") bypasses the background cap
          if (!isHighPriority && sessionRequestsCount >= sessionCap) {
            queue.splice(nextIndex, 1);
            highPriorityIds.delete(candidate.propertyId);
            enqueuedOrActive.delete(candidate.propertyId);
            const result = { status: "capped", propertyId: candidate.propertyId };
            recordTerminalState(candidate.propertyId, result, true);
            notify(candidate.propertyId, result);
            continue;
          }

          // Check memory cache once more before firing network
          const targetId = aliasMap.get(String(candidate.propertyId).toLowerCase()) || candidate.propertyId;
          const cached = memoryCache.get(targetId) || memoryCache.get(candidate.propertyId);
          if (cached && Date.now() - cached.ts < ttlMs && !isShallowPreliminaryPolicy(cached.data?.policy)) {
            queue.splice(nextIndex, 1);
            highPriorityIds.delete(candidate.propertyId);
            enqueuedOrActive.delete(candidate.propertyId);
            notify(candidate.propertyId, cached.data);
            continue;
          }

          // Pacing gate. Jitter is applied ONCE to the resolved max(...), never per term.
          const wait = computeDispatchWait(isHighPriority, Date.now());
          if (wait > 0) {
            scheduleTimer(processQueue, applyJitter(wait));
            break;
          }

          const [nextItem] = queue.splice(nextIndex, 1);
          highPriorityIds.delete(nextItem.propertyId);

          // Execute fetch
          sessionRequestsCount++;
          const dispatchedAt = Date.now();
          lastDispatchAt = dispatchedAt;
          if (!isHighPriority) lastBgStart = dispatchedAt;
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

        const validated = validateListingUrl(url);
        let targetUrl = validated ? validated.fetchUrl : url;

        // Class 14: Force English locale query parameters on Vrbo listing URLs
        try {
          if (typeof targetUrl === "string" && (targetUrl.startsWith("http://") || targetUrl.startsWith("https://") || targetUrl.startsWith("/"))) {
            const parsedUrl = new URL(targetUrl, "https://www.vrbo.com");
            if (/^(?:www\.)?vrbo\.com$/i.test(parsedUrl.hostname)) {
              parsedUrl.searchParams.set("locale", "en_US");
              parsedUrl.searchParams.set("siteid", "1");
              targetUrl = parsedUrl.toString();
            }
          }
        } catch {}

        const res = await fetchFn(targetUrl, {
          signal: controller.signal,
          headers: {
            "Accept-Language": "en-US,en;q=0.9",
          },
        });

        if (isDisposed) return;

        if (res.status === 429 || res.status === 403) {
          // One shared counter: noteHardBlock sets pausedUntil AND advances ladderStep,
          // exactly once for this event.
          noteHardBlock();
          const result = { status: "rate_limited", propertyId };
          recordTerminalState(propertyId, result, false);
          notify(propertyId, result);
          return;
        }

        if (!res.ok) {
          // Only 5xx is server pressure and feeds the error cluster. A 404 (or any
          // other 4xx that is not 429/403) proves the server is healthy and answering
          // — the property is simply gone. It is fully inert, exactly like `unknown`:
          // it neither advances the ladder nor resets the clean window, so a scatter
          // of delisted listings cannot hold the ladder elevated and block recovery.
          if (res.status >= 500) noteSoftFailure();
          const result = { status: "error", code: res.status, propertyId };
          recordTerminalState(propertyId, result, false);
          notify(propertyId, result);
          return;
        }

        // Class 12: Detect redirects & extract canonical ID from res.url
        let canonicalId = null;
        if (res.url && typeof res.url === "string") {
          try {
            const resValidated = validateListingUrl(res.url);
            if (resValidated && resValidated.propertyId && resValidated.propertyId.toLowerCase() !== propertyId.toLowerCase()) {
              canonicalId = resValidated.propertyId;
            }
          } catch {}
        }

        const html = await res.text();
        if (isDisposed) return;

        const parsed = parseListingHtml(html, propertyId, canonicalId);

        if (parsed && parsed.isChallenge) {
          noteHardBlock();
          const result = { status: "rate_limited", propertyId };
          recordTerminalState(propertyId, result, false);
          notify(propertyId, result);
          return;
        }

        const effectiveCanonicalId = canonicalId || parsed?.canonicalId;
        const hasConcrete = hasConcretePolicy(parsed && parsed.policy);

        if (hasConcrete) {
          noteSuccess();
          const data = {
            status: "ok",
            propertyId,
            canonicalId: effectiveCanonicalId || propertyId,
            policy: parsed.policy,
            ts: Date.now(),
          };
          terminalCooldowns.delete(propertyId);
          if (effectiveCanonicalId) terminalCooldowns.delete(effectiveCanonicalId);

          const cachedResult = await setCached(propertyId, data);

          // Class 12 & Class 10: Cache under canonical ID and update alias map
          if (effectiveCanonicalId && effectiveCanonicalId.toLowerCase() !== propertyId.toLowerCase()) {
            await setCached(effectiveCanonicalId, { ...data, propertyId: effectiveCanonicalId });
            aliasMap.set(propertyId.toLowerCase(), effectiveCanonicalId);
            if (storage && typeof storage.set === "function") {
              try {
                storage.set({ [`${ALIAS_PREFIX}${propertyId}`]: effectiveCanonicalId }, () => {});
              } catch {}
            }
          }

          if (parsed?.aliases && Array.isArray(parsed.aliases)) {
            for (const alias of parsed.aliases) {
              if (alias && alias.toLowerCase() !== propertyId.toLowerCase()) {
                aliasMap.set(alias.toLowerCase(), effectiveCanonicalId || propertyId);
              }
            }
          }

          const winner = (cachedResult && cachedResult.data) ? cachedResult.data : data;
          notify(propertyId, winner);
          if (effectiveCanonicalId && effectiveCanonicalId !== propertyId) {
            notify(effectiveCanonicalId, winner);
          }
        } else {
          // `unknown` follows a SUCCESSFUL fetch and parse that found no concrete policy.
          // It is not a failure: it must not advance the ladder and must not reset the
          // clean window, so no pacing signal is emitted here.
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
          noteSoftFailure();
          const result = { status: "timeout", propertyId };
          recordTerminalState(propertyId, result, false);
          notify(propertyId, result);
          return;
        }
        noteSoftFailure();
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

      // 1. Check memory cache synchronously (with alias lookup)
      const targetId = aliasMap.get(String(propertyId).toLowerCase()) || propertyId;
      const mem = memoryCache.get(targetId) || memoryCache.get(propertyId);
      if (mem && Date.now() - mem.ts < ttlMs) {
        notify(propertyId, mem.data);
        if (targetId !== propertyId) notify(targetId, mem.data);
        if (!isShallowPreliminaryPolicy(mem.data?.policy)) {
          return;
        }
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
      const token = ++enqueueSeq;
      pendingEnqueues.set(propertyId, token);
      getCached(propertyId).then((cached) => {
        if (isDisposed) return;
        // remove() (or a newer enqueue) invalidated this staged push.
        if (pendingEnqueues.get(propertyId) !== token) return;
        pendingEnqueues.delete(propertyId);
        if (cached && cached.status === "ok") {
          enqueuedOrActive.delete(propertyId);
          highPriorityIds.delete(propertyId);
          notify(propertyId, cached);
          return;
        }

        queue.push({ propertyId, url, priority });
        processQueue();
      });
    }

    /**
     * I8a: cancel a single queued (or still-staging) item. Returns true if something
     * was cancelled, false for an unknown id or one already in flight.
     *
     * Clearing `enqueuedOrActive` is mandatory, not cosmetic: enqueue() early-returns
     * on `enqueuedOrActive.has(propertyId)`, so splicing the queue array alone would
     * lock that property out of enqueueing for the rest of the session.
     *
     * Deliberately does NOT touch sessionRequestsCount or terminalCooldowns:
     * clearQueue() semantics are unchanged and the session budget must survive.
     */
    function remove(propertyId) {
      if (!propertyId || isDisposed) return false;
      if (activeRequests.has(propertyId)) return false; // in-flight: not removable

      const idx = queue.findIndex((item) => item.propertyId === propertyId);
      const known = idx !== -1 || pendingEnqueues.has(propertyId) || enqueuedOrActive.has(propertyId);
      if (!known) return false;

      if (idx !== -1) queue.splice(idx, 1);
      pendingEnqueues.delete(propertyId);
      enqueuedOrActive.delete(propertyId);
      highPriorityIds.delete(propertyId);
      return true;
    }

    function clearQueue() {
      queue.length = 0;
      enqueuedOrActive.clear();
      highPriorityIds.clear();
      pendingEnqueues.clear();
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
      if (maintenanceIntervalTimer) {
        clearInterval(maintenanceIntervalTimer);
        maintenanceIntervalTimer = null;
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
      remove,
      clearQueue,
      dispose,
      subscribe,
      getQueueLength: () => queue.length,
      getActiveCount: () => activeRequests.size,
      getSessionCount: () => sessionRequestsCount,
      getMaxObservedConcurrency: () => maxObservedConcurrency,
      isPaused: () => Date.now() < pausedUntil,
      getLadderStep: () => ladderStep,
      getEffectiveMinDelayMs: effectiveMinDelayMs,
      getHighPriorityDelayMs: hpMinDelayMs,
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
   * Extract numeric/alphanumeric property ID from a Vrbo listing URL or path.
   * Delegates to shared pure extractor in extract.js.
   */
  function extractPropertyIdFromUrl(urlStr, baseUrl = "https://www.vrbo.com") {
    if (extract && typeof extract.extractPropertyId === "function") {
      return extract.extractPropertyId(urlStr, baseUrl);
    }
    if (!urlStr || typeof urlStr !== "string") return null;
    try {
      const u = new URL(urlStr, baseUrl);
      const m = /(?:\/pdp(?:\/lo)?\/|\/vacation-rentals?(?:\/p)?\/p?|\/)(p?\d+[a-z0-9]*)(?:\/|\?|$)/i.exec(u.pathname);
      if (!m) return null;
      let propId = m[1];
      if (/^p\d+/i.test(propId)) propId = propId.slice(1);
      return propId || null;
    } catch {
      return null;
    }
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

      const propId = extractPropertyIdFromUrl(urlStr, baseUrl);
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
    ALIAS_PREFIX,
    walkApolloNode,
    parseListingHtml,
    hasConcretePolicy,
    resolveSearchApolloRecord,
    createSearchFetchQueue,
    extractPropertyIdFromUrl,
    validateListingUrl,
    performStorageMaintenance,
    calculatePolicyCompleteness,
    canPolicyUpgrade,
    serializeSearchPolicyForCache,
  };
});

