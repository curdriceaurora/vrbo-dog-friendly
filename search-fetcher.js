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
  const DEFAULT_MIN_DELAY_MS = 400;
  const DEFAULT_SESSION_CAP = 40;
  const PAUSE_ON_CHALLENGE_MS = 30000; // 30s backoff if 429 or challenge encountered
  const DEFAULT_COOLDOWN_MS = 30000; // 30s cooldown for terminal states

  /**
   * Walk Apollo graph with full __ref pointer resolution and support for header.text and value/text leaves.
   */
  function walkApolloNode(state, node, headerCtx, sectionCtx, out, visited = new Set(), depth = 0, isExplicitPetContext = false) {
    if (node == null || depth > 35) return;

    if (node && typeof node === "object" && typeof node.__ref === "string") {
      if (visited.has(node.__ref)) return;
      visited.add(node.__ref);
      const target = state[node.__ref];
      if (target) walkApolloNode(state, target, headerCtx, sectionCtx, out, visited, depth + 1, isExplicitPetContext);
      return;
    }

    if (Array.isArray(node)) {
      for (const el of node) walkApolloNode(state, el, headerCtx, sectionCtx, out, visited, depth + 1, isExplicitPetContext);
      return;
    }

    if (typeof node !== "object") return;

    // Multi-Unit Hierarchy Pruning (Class 11):
    // Do not follow unit/room-level branches when inspecting top-level property
    if (node.__typename && /^(?:Unit|RentalUnit|Room|LodgingUnit|RatePlan|RoomType)$/i.test(node.__typename)) {
      return;
    }

    let nextHeader = headerCtx;
    let nextSection = sectionCtx;
    let explicitPet = isExplicitPetContext || Boolean(node.__typename && /^(?:PetPolicy|PropertyPets|PetsAmenity)$/i.test(node.__typename));

    if (node.__typename && /^(?:PetPolicy|PropertyPets|PetsAmenity)$/i.test(node.__typename)) {
      if (!nextHeader || nextHeader === "Listing Data") nextHeader = "Pets";
      if (!nextSection || nextSection === "Rules") nextSection = "House Rules / Policies";
    }

    const headerText = typeof node.header === "object" ? node.header?.text : (typeof node.header === "string" ? node.header : "");
    if (typeof headerText === "string" && headerText.trim()) {
      nextHeader = headerText.trim();
      if (/house rules|polic|important information/i.test(nextHeader)) nextSection = "House Rules / Policies";
      else if (/about this property|about this space|about this listing/i.test(nextHeader)) nextSection = "About this property";
      else if (!nextSection) nextSection = nextHeader;
      if (/^pets?$/i.test(nextHeader)) explicitPet = true;
    }
    if (typeof node.sectionName === "string" && node.sectionName.trim()) {
      nextHeader = node.sectionName.trim();
      if (/house rules|polic/i.test(nextHeader)) nextSection = "House Rules / Policies";
      if (/^pets?$/i.test(nextHeader)) explicitPet = true;
    }

    for (const [k, v] of Object.entries(node)) {
      if ((k === "value" || k === "text" || k === "body" || k === "description") && typeof v === "string" && v.trim().length > 0) {
        out.push({
          header: nextHeader || "Listing Data",
          section: nextSection || nextHeader || "Rules",
          text: v.trim(),
          isDedicatedPetsHeader: explicitPet,
          explicitPetContext: explicitPet,
        });
      } else if (v && typeof v === "object") {
        walkApolloNode(state, v, nextHeader, nextSection, out, visited, depth + 1, explicitPet);
      }
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
      .replace(/<\/(p|div|section|article|li|h[1-6]|tr|td|blockquote)>/gi, "\n");

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
          // Check global pacing delay between network request starts
          const now = Date.now();
          const elapsed = now - lastRequestStartTime;
          if (elapsed < minDelayMs) {
            const waitTime = minDelayMs - elapsed;
            scheduleTimer(processQueue, waitTime);
            break;
          }

          // Pick next item: prioritize items in highPriorityIds or marked priority: "high"
          let nextIndex = queue.findIndex((item) => item.priority === "high" || highPriorityIds.has(item.propertyId));
          const isHighPriority = nextIndex !== -1;
          if (nextIndex === -1) nextIndex = 0;

          const [nextItem] = queue.splice(nextIndex, 1);
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
          const targetId = aliasMap.get(String(nextItem.propertyId).toLowerCase()) || nextItem.propertyId;
          const cached = memoryCache.get(targetId) || memoryCache.get(nextItem.propertyId);
          if (cached && Date.now() - cached.ts < ttlMs) {
            if (!isShallowPreliminaryPolicy(cached.data?.policy)) {
              enqueuedOrActive.delete(nextItem.propertyId);
              notify(nextItem.propertyId, cached.data);
              continue;
            }
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
          pausedUntil = Date.now() + pauseOnChallengeMs;
          const result = { status: "rate_limited", propertyId };
          recordTerminalState(propertyId, result, false);
          notify(propertyId, result);
          return;
        }

        const effectiveCanonicalId = canonicalId || parsed?.canonicalId;
        const hasConcrete = hasConcretePolicy(parsed && parsed.policy);

        if (hasConcrete) {
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
   * Extract numeric/alphanumeric property ID from a Vrbo listing URL or path.
   */
  function extractPropertyIdFromUrl(urlStr, baseUrl = "https://www.vrbo.com") {
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

