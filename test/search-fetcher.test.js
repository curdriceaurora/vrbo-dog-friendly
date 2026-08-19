// test/search-fetcher.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseListingHtml, createSearchFetchQueue, validateListingUrl, performStorageMaintenance, CACHE_PREFIX, serializeSearchPolicyForCache, calculatePolicyCompleteness, canPolicyUpgrade } = require("../search-fetcher.js");

test("search-fetcher HTML parsing", async (t) => {
  await t.test("detects bot challenge HTML and marks as challenge", () => {
    const html = "<html><head><title>Bot or Not?</title></head><body>challenge-running</body></html>";
    const res = parseListingHtml(html, "12345");
    assert.equal(res.isChallenge, true);
  });

  await t.test("parses live Apollo state with nested header.text and value leaves", () => {
    const apolloState = {
      "PropertyInfo:12345": {
        rules: { __ref: "RulesBlock:789" },
      },
      "RulesBlock:789": {
        ruleList: [
          { __ref: "RuleItem:1" },
        ],
      },
      "RuleItem:1": {
        header: { text: "Pets" },
        value: "No pets allowed.",
      },
    };
    const html = `<html><script>window.__APOLLO_STATE__ = ${JSON.stringify(apolloState)};</script></html>`;
    const res = parseListingHtml(html, "12345");
    assert.equal(res.ok, true);
    assert.equal(res.policy.petsAllowed, false);
  });

  await t.test("parses embedded Apollo state with __ref references and multiple attributes", () => {
    const apolloState = {
      "PropertyInfo:12345": {
        rules: { __ref: "RulesBlock:789" },
      },
      "RulesBlock:789": {
        ruleList: [
          { __ref: "RuleItem:1" },
        ],
      },
      "RuleItem:1": {
        header: "House Rules",
        section: "Rules",
        text: "Dogs welcome, maximum 2 dogs under 50 lbs. $150 pet fee applies.",
      },
    };
    const html = `<html><script>window.__APOLLO_STATE__ = ${JSON.stringify(apolloState)};</script></html>`;
    const res = parseListingHtml(html, "12345");
    assert.equal(res.ok, true);
    assert.equal(res.policy.petsAllowed, true);
    assert.equal(res.policy.maxDogs, 2);
    assert.deepEqual(res.policy.weightLimit, { value: 50, unit: "lb", pounds: 50 });
    assert.deepEqual(res.policy.fee, { amount: 150, currency: "USD", period: "unknown" });
  });

  await t.test("parses raw HTML markup if Apollo state is not present", () => {
    const html = `
      <html>
        <body>
          <section class="house-rules">
            <h2>House Rules</h2>
            <p>Pets are welcome here! Maximum of 1 dog allowed, pet fee is $75 per stay.</p>
          </section>
        </body>
      </html>
    `;
    const res = parseListingHtml(html, "99999");
    assert.equal(res.ok, true);
    assert.equal(res.policy.petsAllowed, true);
    assert.equal(res.policy.maxDogs, 1);
    assert.deepEqual(res.policy.fee, { amount: 75, currency: "USD", period: "stay" });
  });

  await t.test("strictly matches propertyId in Apollo state and does not fall back to other properties", () => {
    const apolloState = {
      "PropertyInfo:OTHER_PROPERTY": {
        header: { text: "House Rules" },
        petsAllowed: false,
        ruleList: [{ __ref: "RuleItem:OTHER" }],
      },
      "RuleItem:OTHER": {
        header: "House Rules",
        section: "Rules",
        text: "No pets allowed under any circumstances.",
      },
    };
    const htmlWithOtherApolloAndNoVisibleRules = `<html><script>window.__APOLLO_STATE__ = ${JSON.stringify(apolloState)};</script><body><div>Welcome to lovely home</div></body></html>`;
    const resMissing = parseListingHtml(htmlWithOtherApolloAndNoVisibleRules, "MISSING_PROPERTY");
    assert.equal(resMissing, null, "Should not return OTHER_PROPERTY's policy for MISSING_PROPERTY");

    const htmlWithOtherApolloAndVisibleRules = `<html><script>window.__APOLLO_STATE__ = ${JSON.stringify(apolloState)};</script><body><section><h2>House Rules</h2><p>Dogs allowed up to 40 lbs.</p></section></body></html>`;
    const resVisible = parseListingHtml(htmlWithOtherApolloAndVisibleRules, "MISSING_PROPERTY");
    assert.equal(resVisible.ok, true);
    assert.equal(resVisible.policy.petsAllowed, true, "Should fall back to visible HTML rules, not other property Apollo record");
    assert.deepEqual(resVisible.policy.weightLimit, { value: 40, unit: "lb", pounds: 40 });
  });

  await t.test("returns null for empty or irrelevant HTML", () => {
    const html = "<html><body><h1>Page Not Found</h1></body></html>";
    const res = parseListingHtml(html, "00000");
    assert.equal(res, null);
  });
});

test("search-fetcher queue and caching", async (t) => {
  await t.test("respects maximum observed concurrency cap", async () => {
    let inFlight = 0;
    let maxObserved = 0;

    const mockFetch = async (url) => {
      inFlight++;
      maxObserved = Math.max(maxObserved, inFlight);
      await new Promise((r) => setTimeout(r, 60));
      inFlight--;
      return {
        ok: true,
        status: 200,
        text: async () => "<section>Dogs allowed</section>",
      };
    };

    const queue = createSearchFetchQueue({
      fetchFn: mockFetch,
      maxConcurrent: 2,
      minDelayMs: 15,
    });

    for (let i = 1; i <= 6; i++) {
      queue.enqueue(`prop_${i}`, `https://www.vrbo.com/${i}`);
    }

    await new Promise((r) => setTimeout(r, 450));
    assert.ok(maxObserved <= 2, `Expected maxObserved <= 2, got ${maxObserved}`);
    assert.ok(queue.getMaxObservedConcurrency() <= 2);
    queue.dispose();
  });

  await t.test("deduplicates concurrent duplicate enqueues", async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 50));
      return {
        ok: true,
        status: 200,
        text: async () => "<section>Dogs allowed</section>",
      };
    };

    const queue = createSearchFetchQueue({
      fetchFn: mockFetch,
      maxConcurrent: 2,
      minDelayMs: 10,
    });

    queue.enqueue("prop_dup", "https://www.vrbo.com/dup");
    queue.enqueue("prop_dup", "https://www.vrbo.com/dup");
    queue.enqueue("prop_dup", "https://www.vrbo.com/dup");

    await new Promise((r) => setTimeout(r, 150));
    assert.equal(callCount, 1, "Duplicate enqueues should only trigger 1 fetch");
    queue.dispose();
  });

  await t.test("deletes expired cache entries from storage", async () => {
    const removedKeys = [];
    const mockStorage = {
      store: {
        "vrbow_cache_old": {
          cacheVersion: 1,
          propertyId: "old",
          storedAt: Date.now() - (48 * 60 * 60 * 1000),
          expiresAt: Date.now() - (24 * 60 * 60 * 1000),
          data: { status: "ok", policy: { schemaVersion: 1, petsAllowed: true } },
        },
      },
      get(keys, cb) {
        const res = {};
        for (const k of keys) {
          if (this.store[k]) res[k] = this.store[k];
        }
        cb(res);
      },
      remove(keys, cb) {
        for (const k of keys) {
          delete this.store[k];
          removedKeys.push(k);
        }
        cb && cb();
      },
    };

    const queue = createSearchFetchQueue({
      storage: mockStorage,
      ttlMs: 24 * 60 * 60 * 1000,
    });

    const cached = await queue.getCached("old");
    assert.equal(cached, null, "Expired entry should return null");
    assert.ok(removedKeys.includes("vrbow_cache_old"), "Expired entry should be removed from storage");
    queue.dispose();
  });

  await t.test("immediately pauses queue on 429 before starting queued requests", async () => {
    let startedCount = 0;
    const mockFetch = async () => {
      startedCount++;
      return {
        ok: false,
        status: 429,
      };
    };

    const queue = createSearchFetchQueue({
      fetchFn: mockFetch,
      maxConcurrent: 1,
      minDelayMs: 60,
      pauseOnChallengeMs: 1000,
    });

    queue.enqueue("p1", "https://www.vrbo.com/1");
    queue.enqueue("p2", "https://www.vrbo.com/2");

    await new Promise((r) => setTimeout(r, 150));

    assert.equal(startedCount, 1);
    assert.equal(queue.isPaused(), true);
    queue.dispose();
  });

  await t.test("prioritizes high-priority items and promotes existing queued items on hover", async () => {
    const executionOrder = [];
    const mockFetch = async (url) => {
      const id = url.split("/").pop().split("?")[0];
      executionOrder.push(id);
      await new Promise((r) => setTimeout(r, 20));
      return {
        ok: true,
        status: 200,
        text: async () => "<section>Pets welcome</section>",
      };
    };

    const queue = createSearchFetchQueue({
      fetchFn: mockFetch,
      maxConcurrent: 1,
      minDelayMs: 15,
    });

    // Enqueue a, b, c in order
    queue.enqueue("a", "https://www.vrbo.com/a", "normal");
    queue.enqueue("b", "https://www.vrbo.com/b", "normal");
    queue.enqueue("c", "https://www.vrbo.com/c", "normal");

    // Promote 'c' on hover while 'a' is in flight
    queue.enqueue("c", "https://www.vrbo.com/c", "high");

    await new Promise((r) => setTimeout(r, 250));

    // Order must be a (in-flight) -> c (promoted high) -> b (normal)
    assert.deepEqual(executionOrder, ["a", "c", "b"], `Expected [a, c, b], got ${JSON.stringify(executionOrder)}`);
    queue.dispose();
  });

  await t.test("cache validates cacheVersion and policy schemaVersion, discarding obsolete envelopes", async () => {
    const removedKeys = [];
    const mockStorage = {
      store: {
        "vrbow_cache_valid": {
          cacheVersion: 1,
          propertyId: "valid",
          storedAt: Date.now() - 1000,
          expiresAt: Date.now() + 100000,
          data: {
            status: "ok",
            policy: {
              schemaVersion: 1,
              petsAllowed: true,
            },
          },
        },
        "vrbow_cache_obsolete_schema": {
          cacheVersion: 1,
          propertyId: "obsolete_schema",
          storedAt: Date.now() - 1000,
          expiresAt: Date.now() + 100000,
          data: {
            status: "ok",
            policy: {
              schemaVersion: 99, // Incompatible/obsolete
              petsAllowed: true,
            },
          },
        },
      },
      get(keys, cb) {
        const res = {};
        for (const k of keys) {
          if (this.store[k]) res[k] = this.store[k];
        }
        cb(res);
      },
      remove(keys, cb) {
        for (const k of keys) {
          delete this.store[k];
          removedKeys.push(k);
        }
        cb && cb();
      },
    };

    const queue = createSearchFetchQueue({
      storage: mockStorage,
    });

    const validHit = await queue.getCached("valid");
    assert.ok(validHit !== null, "Valid schemaVersion: 1 should hit cache");
    assert.equal(validHit.policy.petsAllowed, true);

    const obsoleteHit = await queue.getCached("obsolete_schema");
    assert.equal(obsoleteHit, null, "Obsolete policy schema should be treated as cache miss");
    assert.ok(removedKeys.includes("vrbow_cache_obsolete_schema"), "Obsolete entry must be pruned");

    queue.dispose();
  });

  await t.test("explicit high-priority hover request bypasses background sessionCap", async () => {
    let fetchCount = 0;
    const mockFetch = async () => {
      fetchCount++;
      return {
        ok: true,
        status: 200,
        text: async () => "<section>Pets welcome</section>",
      };
    };

    const queue = createSearchFetchQueue({
      fetchFn: mockFetch,
      maxConcurrent: 1,
      minDelayMs: 5,
      sessionCap: 1, // session cap of 1
    });

    const notifications = [];
    queue.subscribe("p1", (res) => notifications.push({ id: "p1", res }));
    queue.subscribe("p2_bg", (res) => notifications.push({ id: "p2_bg", res }));
    queue.subscribe("p3_hover", (res) => notifications.push({ id: "p3_hover", res }));

    // Request 1: uses the 1 session cap slot
    queue.enqueue("p1", "https://www.vrbo.com/1", "normal");
    await new Promise((r) => setTimeout(r, 25));

    // Request 2 (normal priority): gets capped
    queue.enqueue("p2_bg", "https://www.vrbo.com/2", "normal");
    await new Promise((r) => setTimeout(r, 25));

    // Request 3 (high priority / explicit hover): bypasses background cap
    queue.enqueue("p3_hover", "https://www.vrbo.com/3", "high");
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(fetchCount, 2, "2 fetches should have run (p1 background + p3_hover explicit)");
    const p2Res = notifications.find((n) => n.id === "p2_bg");
    assert.equal(p2Res?.res?.status, "capped", "p2_bg should be capped");
    const p3Res = notifications.find((n) => n.id === "p3_hover");
    assert.equal(p3Res?.res?.status, "ok", "p3_hover should successfully fetch");

    queue.dispose();
  });

  await t.test("8.1.2: ten hover events following one timeout produce no additional request during cooldown", async () => {
    let fetchAttempts = 0;
    const notifications = [];

    const mockFetch = (_url, options) => {
      fetchAttempts++;
      return new Promise((resolve, reject) => {
        if (options?.signal) {
          options.signal.addEventListener("abort", () => {
            const err = new Error("Request timed out");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    };

    const queue = createSearchFetchQueue({
      fetchFn: mockFetch,
      maxConcurrent: 1,
      minDelayMs: 5,
      requestTimeoutMs: 30, // 30ms timeout
      cooldownMs: 5000, // 5s cooldown
    });

    queue.subscribe("p_timeout", (res) => notifications.push(res));

    // Initial attempt (e.g. background or initial hover)
    queue.enqueue("p_timeout", "https://www.vrbo.com/timeout", "normal");

    // Wait for timeout to fire
    await new Promise((r) => setTimeout(r, 80));

    assert.equal(fetchAttempts, 1, "Initial fetch should have run");
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].status, "timeout");
    assert.equal(queue.isInCooldown("p_timeout"), true, "Property should be in terminal cooldown");

    // Simulate 10 repeated hover / focus events during cooldown
    for (let i = 0; i < 10; i++) {
      queue.enqueue("p_timeout", "https://www.vrbo.com/timeout", "high");
    }

    await new Promise((r) => setTimeout(r, 60));

    assert.equal(fetchAttempts, 1, "Zero additional fetches should occur during terminal cooldown across 10 hovers");
    assert.equal(notifications.length, 11, "Subscribers should receive current terminal state for each hover without fetching");
    assert.equal(notifications[notifications.length - 1].status, "timeout");

    // Verify getCached returns terminal state during cooldown
    const cached = await queue.getCached("p_timeout");
    assert.deepEqual(cached, { status: "timeout", propertyId: "p_timeout" });

    queue.dispose();
  });

  await t.test("8.1.2: capped result permits one explicit bypass attempt, repeated hovers while active or cooling down do not create more requests", async () => {
    let fetchAttempts = 0;
    let fetchResolver;

    const mockFetch = (_url, options) => {
      fetchAttempts++;
      return new Promise((resolve, reject) => {
        fetchResolver = () => {
          resolve({
            ok: false,
            status: 500,
          });
        };
        if (options?.signal) {
          options.signal.addEventListener("abort", () => {
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
      minDelayMs: 5,
      sessionCap: 0, // session cap 0 means all background requests get capped
      cooldownMs: 5000,
    });

    const notifications = [];
    queue.subscribe("p_capped", (res) => notifications.push(res));

    // Step 1: Background enqueue -> capped
    queue.enqueue("p_capped", "https://www.vrbo.com/capped", "normal");
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(fetchAttempts, 0, "No network request when background capped");
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].status, "capped");

    // Step 2: User hovers -> permits 1 explicit bypass attempt
    queue.enqueue("p_capped", "https://www.vrbo.com/capped", "high");
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(fetchAttempts, 1, "Explicit high-priority hover should trigger 1 fetch attempt");

    // Step 3: Repeated hovers while attempt is active (in-flight) deduplicate
    queue.enqueue("p_capped", "https://www.vrbo.com/capped", "high");
    queue.enqueue("p_capped", "https://www.vrbo.com/capped", "high");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(fetchAttempts, 1, "Repeated hovers while in-flight must not create new requests");

    // Step 4: Resolve attempt with terminal error (500)
    fetchResolver();
    await new Promise((r) => setTimeout(r, 40));

    const errNotification = notifications.find((n) => n.status === "error");
    assert.ok(errNotification, "Should receive terminal error notification");
    assert.equal(queue.isInCooldown("p_capped"), true, "Property should be cooling down");

    // Step 5: Repeated hovers during cooldown do not create requests
    for (let i = 0; i < 5; i++) {
      queue.enqueue("p_capped", "https://www.vrbo.com/capped", "high");
    }
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(fetchAttempts, 1, "Total fetch attempts must remain exactly 1");

    queue.dispose();
  });

  await t.test("8.1.2: unknown and rate_limited results enter cooldown and clear on dispose", async () => {
    let fetchCount = 0;
    const mockFetch = async (url) => {
      fetchCount++;
      if (url.includes("unknown")) {
        return { ok: true, status: 200, text: async () => "<html><body>No policy</body></html>" };
      }
      if (url.includes("rate_limited")) {
        return { ok: false, status: 429 };
      }
      return { ok: false, status: 500 };
    };

    const queue = createSearchFetchQueue({
      fetchFn: mockFetch,
      maxConcurrent: 1,
      minDelayMs: 5,
      cooldownMs: 5000,
      pauseOnChallengeMs: 5000,
    });

    // Test unknown result cooldown
    queue.enqueue("p_unk", "https://www.vrbo.com/unknown", "normal");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(fetchCount, 1);
    assert.equal(queue.isInCooldown("p_unk"), true);

    // Repeated hover on unknown
    queue.enqueue("p_unk", "https://www.vrbo.com/unknown", "high");
    queue.enqueue("p_unk", "https://www.vrbo.com/unknown", "high");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(fetchCount, 1, "Repeated hover on unknown must not trigger new fetch");

    // Test dispose clears cooldowns
    queue.dispose();
    assert.equal(queue.isInCooldown("p_unk"), false, "Dispose should clear cooldown map");
  });

  await t.test("8.1.3: validateListingUrl separates navigation URL from query-free canonical fetch URL", () => {
    // 1. Full search navigation URL with dates, guests, search ID, and hash
    const rawUrl = "https://www.vrbo.com/3173015?chkin=2026-09-01&chkout=2026-09-05&adults=2&children=1_5&searchId=abc123#gallery";
    const result = validateListingUrl(rawUrl);

    assert.ok(result !== null, "Valid Vrbo listing URL should parse successfully");
    assert.equal(result.propertyId, "3173015");
    assert.equal(result.navigationUrl, rawUrl, "navigationUrl must preserve original query params and hash");
    assert.equal(result.fetchUrl, "https://www.vrbo.com/3173015", "fetchUrl must strip all query params and hash");

    // 2. PDP path variation
    const pdpUrl = "https://www.vrbo.com/pdp/987654?unitId=987654&foo=bar#reviews";
    const pdpResult = validateListingUrl(pdpUrl);
    assert.ok(pdpResult !== null);
    assert.equal(pdpResult.propertyId, "987654");
    assert.equal(pdpResult.navigationUrl, pdpUrl);
    assert.equal(pdpResult.fetchUrl, "https://www.vrbo.com/pdp/987654");

    // 3. Vacation-rentals path variation
    const vrUrl = "https://www.vrbo.com/vacation-rentals/p123456?adults=1";
    const vrResult = validateListingUrl(vrUrl);
    assert.ok(vrResult !== null);
    assert.equal(vrResult.propertyId, "123456");
    assert.equal(vrResult.fetchUrl, "https://www.vrbo.com/vacation-rentals/p123456");

    // 4. Relative URL with base
    const relUrl = "/3173015?chkin=2026-09-01";
    const relResult = validateListingUrl(relUrl, "https://www.vrbo.com/Hotel-Search");
    assert.ok(relResult !== null);
    assert.equal(relResult.propertyId, "3173015");
    assert.equal(relResult.navigationUrl, "https://www.vrbo.com/3173015?chkin=2026-09-01");
    assert.equal(relResult.fetchUrl, "https://www.vrbo.com/3173015");

    // 5. Non-HTTPS rejected
    assert.equal(validateListingUrl("http://www.vrbo.com/3173015"), null, "HTTP URLs must be rejected");

    // 6. Non-Vrbo domains rejected
    assert.equal(validateListingUrl("https://www.airbnb.com/rooms/3173015"), null, "Non-Vrbo domains must be rejected");
    assert.equal(validateListingUrl("https://www.expedia.com/3173015"), null, "Expedia domain must be rejected");
    assert.equal(validateListingUrl("https://malicious-vrbo.com/3173015"), null, "Phishing domain must be rejected");

    // 7. Non-listing Vrbo paths rejected
    assert.equal(validateListingUrl("https://www.vrbo.com/help"), null, "Help page is not a listing");
    assert.equal(validateListingUrl("https://www.vrbo.com/Hotel-Search?destination=Maui"), null, "Search page is not a listing");
    assert.equal(validateListingUrl("https://www.vrbo.com/user/profile"), null, "User page is not a listing");
  });

  await t.test("8.1.8: cache round-trip preserves fee period 'day'", async () => {
    let storageMap = {};
    const testStorage = {
      get: (keys, cb) => {
        const res = {};
        for (const k of [].concat(keys)) {
          if (storageMap[k]) res[k] = storageMap[k];
        }
        cb(res);
      },
      set: (obj, cb) => {
        Object.assign(storageMap, obj);
        cb && cb();
      },
      remove: (keys, cb) => {
        for (const k of [].concat(keys)) delete storageMap[k];
        cb && cb();
      },
    };

    const mockFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => "<section>House Rules: Dogs allowed. Pet fee of $35 per day.</section>",
    });

    const queue = createSearchFetchQueue({
      fetchFn: mockFetch,
      storage: testStorage,
      maxConcurrent: 1,
      minDelayMs: 5,
    });

    let received = null;
    queue.subscribe("889900", (data) => {
      received = data;
    });

    queue.enqueue("889900", "https://www.vrbo.com/889900", "normal");
    await new Promise((r) => setTimeout(r, 40));

    assert.ok(received !== null);
    assert.equal(received.status, "ok");
    assert.equal(received.policy.fee.amount, 35);
    assert.equal(received.policy.fee.period, "day");

    // Cache retrieval test
    const cached = await queue.getCached("889900");
    assert.ok(cached !== null);
    assert.equal(cached.policy.fee.amount, 35);
    assert.equal(cached.policy.fee.period, "day", "Cached fee must retain period: 'day'");

    queue.dispose();
  });

  await t.test("8.2.7: performStorageMaintenance sweeps expired, corrupt, and schema-incompatible keys while preserving valid Vrbow keys and unrelated keys", async () => {
    const now = 1700000000000;
    const removedLog = [];

    const mockStorage = {
      store: {
        // Valid, unexpired Vrbow cache entries (MUST BE KEPT)
        "vrbow_cache_valid_1": {
          cacheVersion: 1,
          propertyId: "valid_1",
          storedAt: now - 3600000,
          expiresAt: now + 3600000,
          data: { status: "ok", policy: { schemaVersion: 1, petsAllowed: true } },
        },
        "vrbow_cache_valid_2": {
          cacheVersion: 1,
          propertyId: "valid_2",
          storedAt: now - 7200000,
          expiresAt: now + 7200000,
          data: { status: "ok", policy: { schemaVersion: 1, petsAllowed: false } },
        },

        // Expired Vrbow cache entry (MUST BE REMOVED)
        "vrbow_cache_expired": {
          cacheVersion: 1,
          propertyId: "expired",
          storedAt: now - 86400000 * 2,
          expiresAt: now - 86400000,
          data: { status: "ok", policy: { schemaVersion: 1, petsAllowed: true } },
        },

        // Incompatible cache version (MUST BE REMOVED)
        "vrbow_cache_incompatible_version": {
          cacheVersion: 99,
          propertyId: "incompatible_version",
          storedAt: now,
          expiresAt: now + 86400000,
          data: { status: "ok", policy: { schemaVersion: 1, petsAllowed: true } },
        },

        // Incompatible policy schema version (MUST BE REMOVED)
        "vrbow_cache_incompatible_schema": {
          cacheVersion: 1,
          propertyId: "incompatible_schema",
          storedAt: now,
          expiresAt: now + 86400000,
          data: { status: "ok", policy: { schemaVersion: 99, petsAllowed: true } },
        },

        // Corrupted entry (MUST BE REMOVED)
        "vrbow_cache_corrupted": null,

        // Unrelated storage keys (MUST BE PRESERVED UNTOUCHED)
        "user_settings": { theme: "dark", compactBadges: true },
        "search_query_history": ["austin", "lake tahoe"],
        "auth_session_token": "vrbo_auth_12345",
      },
      get(keys, cb) {
        if (!keys) {
          cb({ ...this.store });
          return;
        }
        const res = {};
        for (const k of keys) {
          if (this.store[k] !== undefined) res[k] = this.store[k];
        }
        cb(res);
      },
      remove(keys, cb) {
        for (const k of keys) {
          delete this.store[k];
          removedLog.push(k);
        }
        cb && cb();
      },
    };

    const result = await performStorageMaintenance(mockStorage, { now });

    assert.equal(result.inspected, 6, "Should inspect all 6 vrbow_cache_ keys");
    assert.equal(result.removed, 4, "Should remove exactly 4 stale/incompatible vrbow_cache_ keys");
    assert.deepEqual(
      result.removedKeys.sort(),
      [
        "vrbow_cache_corrupted",
        "vrbow_cache_expired",
        "vrbow_cache_incompatible_schema",
        "vrbow_cache_incompatible_version",
      ].sort()
    );

    // Verify final storage state:
    // 1. Valid Vrbow keys are preserved
    assert.ok(mockStorage.store["vrbow_cache_valid_1"] !== undefined);
    assert.ok(mockStorage.store["vrbow_cache_valid_2"] !== undefined);

    // 2. Stale Vrbow keys are gone
    assert.equal(mockStorage.store["vrbow_cache_expired"], undefined);
    assert.equal(mockStorage.store["vrbow_cache_incompatible_version"], undefined);
    assert.equal(mockStorage.store["vrbow_cache_incompatible_schema"], undefined);
    assert.equal(mockStorage.store["vrbow_cache_corrupted"], undefined);

    // 3. Unrelated keys are completely untouched
    assert.deepEqual(mockStorage.store["user_settings"], { theme: "dark", compactBadges: true });
    assert.deepEqual(mockStorage.store["search_query_history"], ["austin", "lake tahoe"]);
    assert.equal(mockStorage.store["auth_session_token"], "vrbo_auth_12345");
  });

  await t.test("8.2.7: createSearchFetchQueue automatically sweeps stale storage keys in the background on startup without blocking queue operations", async () => {
    const now = Date.now();
    const removedLog = [];

    const mockStorage = {
      store: {
        "vrbow_cache_old_stale": {
          cacheVersion: 1,
          propertyId: "old_stale",
          storedAt: now - (48 * 3600000),
          expiresAt: now - (24 * 3600000),
          data: { status: "ok", policy: { schemaVersion: 1, petsAllowed: true } },
        },
        "vrbow_cache_fresh": {
          cacheVersion: 1,
          propertyId: "fresh",
          storedAt: now - 3600000,
          expiresAt: now + (23 * 3600000),
          data: { status: "ok", policy: { schemaVersion: 1, petsAllowed: true } },
        },
        "unrelated_key": "some_other_data",
      },
      get(keys, cb) {
        if (!keys) {
          cb({ ...this.store });
          return;
        }
        const res = {};
        for (const k of keys) {
          if (this.store[k] !== undefined) res[k] = this.store[k];
        }
        cb(res);
      },
      remove(keys, cb) {
        for (const k of keys) {
          delete this.store[k];
          removedLog.push(k);
        }
        cb && cb();
      },
      set(items, cb) {
        Object.assign(this.store, items);
        cb && cb();
      },
    };

    let fetchCount = 0;
    const mockFetch = async () => {
      fetchCount++;
      return {
        ok: true,
        status: 200,
        text: async () => "<section>House Rules: Dogs allowed</section>",
      };
    };

    const queue = createSearchFetchQueue({
      fetchFn: mockFetch,
      storage: mockStorage,
      maxConcurrent: 2,
      minDelayMs: 5,
    });

    // Enqueue immediately without waiting for maintenance
    queue.enqueue("prop_fast", "https://www.vrbo.com/prop_fast");

    await new Promise((r) => setTimeout(r, 60));

    // Stale key was swept in the background
    assert.equal(mockStorage.store["vrbow_cache_old_stale"], undefined);
    assert.ok(mockStorage.store["vrbow_cache_fresh"] !== undefined);
    assert.equal(mockStorage.store["unrelated_key"], "some_other_data");

    // Queue operation succeeded without delay
    assert.equal(fetchCount, 1);

    queue.dispose();
  });

  await t.test("createSearchFetchQueue executes recurring storage maintenance on interval and stops on dispose", async () => {
    let maintenanceCount = 0;
    const now = Date.now();
    const mockStorage = {
      store: {},
      get(keys, cb) {
        maintenanceCount++;
        cb({ ...this.store });
      },
      remove(keys, cb) {
        cb && cb();
      },
    };

    const queue = createSearchFetchQueue({
      storage: mockStorage,
      maintenanceIntervalMs: 25,
    });

    // Startup sweep runs immediately
    assert.equal(maintenanceCount, 1);

    // Wait for interval ticks with generous timing slack for CI boxes
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(maintenanceCount >= 2, `Expected at least 2 maintenance sweeps, got ${maintenanceCount}`);

    const countBeforeDispose = maintenanceCount;
    queue.dispose();

    // After dispose, no further sweeps occur
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(maintenanceCount, countBeforeDispose);
  });

  await t.test("persistence boundary: serializeSearchPolicyForCache allowlists canonical fields and strips all raw DOM excerpts", () => {
    const rawPolicyWithSnippets = {
      schemaVersion: 1,
      propertyId: "12345",
      source: "listing-page",
      extractedAt: "2026-08-18T00:00:00.000Z",
      petsAllowed: true,
      maxDogs: 2,
      weightLimit: { value: 50, unit: "lb", pounds: 50 },
      fee: { amount: 150, currency: "USD", period: "stay" },
      deposit: { amount: 200, currency: "USD" },
      approvalRequired: false,
      restrictionsFound: true,
      confidence: "high",
      _raw: {
        petsAllowedSnippet: "Full host text snippet here that should not be in cache",
        maxDogsSnippet: "Host max dogs quote",
        otherNotes: [{ text: "Long host description paragraph", source: "House Rules" }],
        rawEntries: ["<div>Lots of raw HTML</div>"],
      },
      snippets: ["snippet 1", "snippet 2"],
      alternates: [{ value: 75, snippet: "alt snippet" }],
    };

    const serialized = serializeSearchPolicyForCache(rawPolicyWithSnippets);

    // Allowlisted canonical fields
    assert.equal(serialized.schemaVersion, 1);
    assert.equal(serialized.propertyId, "12345");
    assert.equal(serialized.petsAllowed, true);
    assert.equal(serialized.maxDogs, 2);
    assert.deepStrictEqual(serialized.weightLimit, { value: 50, unit: "lb", pounds: 50 });
    assert.deepStrictEqual(serialized.fee, { amount: 150, currency: "USD", period: "stay" });
    assert.deepStrictEqual(serialized.deposit, { amount: 200, currency: "USD" });
    assert.equal(serialized.approvalRequired, false);
    assert.equal(serialized.restrictionsFound, true);
    assert.equal(serialized.confidence, "high");

    // Strictly forbidden raw fields
    assert.equal(serialized._raw, undefined, "Cache serialization must never retain _raw");
    assert.equal(serialized.snippets, undefined, "Cache serialization must never retain snippets");
    assert.equal(serialized.alternates, undefined, "Cache serialization must never retain alternates");
    assert.equal(serialized.rawEntries, undefined, "Cache serialization must never retain rawEntries");
  });

  await t.test("cache precedence contract: shallow search Apollo payload never downgrades detailed cached listing policy", async () => {
    const mockStorage = {
      store: {},
      get(keys, cb) {
        if (!keys) {
          cb({ ...this.store });
          return;
        }
        const res = {};
        for (const k of keys) {
          if (this.store[k] !== undefined) res[k] = this.store[k];
        }
        cb(res);
      },
      set(items, cb) {
        Object.assign(this.store, items);
        cb && cb();
      },
      remove(keys, cb) {
        for (const k of keys) delete this.store[k];
        cb && cb();
      },
    };

    const queue = createSearchFetchQueue({
      fetchFn: async () => ({ ok: true, status: 200, text: async () => "" }),
      storage: mockStorage,
      maxConcurrent: 1,
      minDelayMs: 5,
    });

    const detailedListingPolicy = {
      schemaVersion: 1,
      propertyId: "prop_detailed",
      source: "listing-page",
      petsAllowed: true,
      maxDogs: 2,
      weightLimit: { value: 50, unit: "lb", pounds: 50 },
      fee: { amount: 150, currency: "USD", period: "stay" },
      deposit: { amount: 200, currency: "USD" },
      approvalRequired: true,
      restrictionsFound: true,
      confidence: "high",
    };

    // 1. Prime cache with detailed listing policy
    await queue.setCached("prop_detailed", {
      status: "ok",
      policy: detailedListingPolicy,
    });

    const primeCache = await queue.getCached("prop_detailed");
    assert.equal(primeCache.policy.maxDogs, 2);
    assert.equal(primeCache.policy.weightLimit.value, 50);

    // 2. Incoming shallow search Apollo payload with only petsAllowed: true
    const shallowApolloPolicy = {
      schemaVersion: 1,
      propertyId: "prop_detailed",
      source: "search-page-state",
      petsAllowed: true,
      maxDogs: null,
      weightLimit: null,
      fee: null,
      deposit: null,
      approvalRequired: null,
      restrictionsFound: false,
      confidence: "medium",
    };

    // Attempt to setCached with shallow Apollo policy
    await queue.setCached("prop_detailed", {
      status: "ok",
      policy: shallowApolloPolicy,
    });

    // 3. Assert detailed policy was preserved and not downgraded
    const afterShallowAttempt = await queue.getCached("prop_detailed");
    assert.equal(afterShallowAttempt.policy.maxDogs, 2, "Detailed maxDogs must be preserved");
    assert.equal(afterShallowAttempt.policy.weightLimit.value, 50, "Detailed weightLimit must be preserved");
    assert.equal(afterShallowAttempt.policy.fee.amount, 150, "Detailed fee must be preserved");

    // 4. Assert upgrading a partial policy with a richer listing policy succeeds
    const partialPolicy = {
      schemaVersion: 1,
      propertyId: "prop_partial",
      source: "search-page-state",
      petsAllowed: true,
      maxDogs: null,
      weightLimit: null,
      fee: null,
    };
    await queue.setCached("prop_partial", { status: "ok", policy: partialPolicy });

    const richIncomingPolicy = {
      schemaVersion: 1,
      propertyId: "prop_partial",
      source: "listing-page",
      petsAllowed: true,
      maxDogs: 1,
      weightLimit: { value: 30, unit: "lb", pounds: 30 },
      fee: { amount: 50, currency: "USD", period: "stay" },
    };
    await queue.setCached("prop_partial", { status: "ok", policy: richIncomingPolicy });

    const upgraded = await queue.getCached("prop_partial");
    assert.equal(upgraded.policy.maxDogs, 1, "Richer policy must upgrade partial policy");
    assert.equal(upgraded.policy.fee.amount, 50, "Richer policy must upgrade partial fee");

    queue.dispose();
  });

  await t.test("persistence boundary: preserves fee.text, contradictions, and restrictionNoteCount", () => {
    const richPolicy = {
      schemaVersion: 1,
      propertyId: "12345",
      source: "listing-page",
      extractedAt: new Date().toISOString(),
      petsAllowed: true,
      maxDogs: 2,
      weightLimit: { value: 50, unit: "lb", pounds: 50 },
      fee: { amount: null, text: "Pet fee applies", currency: "USD", period: "unknown" },
      deposit: { amount: 100, text: "$100 deposit", currency: "USD" },
      approvalRequired: false,
      restrictionsFound: true,
      contradictions: { maxDogs: true, weightLimit: false, fee: false },
      restrictionNoteCount: 3,
      confidence: "high",
      _raw: { domText: "secret excerpt" },
    };

    const serialized = serializeSearchPolicyForCache(richPolicy);
    assert.equal(serialized.fee.text, "Pet fee applies", "fee.text must be preserved");
    assert.equal(serialized.deposit.text, "$100 deposit", "deposit.text must be preserved");
    assert.deepEqual(serialized.contradictions, { maxDogs: true, weightLimit: false, fee: false }, "contradictions object must be preserved");
    assert.equal(serialized.restrictionNoteCount, 3, "restrictionNoteCount must be preserved");
    assert.equal(serialized._raw, undefined, "_raw must be stripped");
  });

  await t.test("subscriber notification delivers winning cache record when candidate is rejected", async () => {
    let fetchCount = 0;
    let resolveFetch;
    const fetchPromise = new Promise((resolve) => {
      resolveFetch = resolve;
    });

    const mockFetch = async () => {
      fetchCount++;
      return fetchPromise;
    };

    const queue = createSearchFetchQueue({
      fetchFn: mockFetch,
      maxConcurrent: 1,
      minDelayMs: 10,
    });

    let notifiedResult = null;
    queue.subscribe("p_win", (result) => {
      notifiedResult = result;
    });

    // 1. Start in-flight fetch
    queue.enqueue("p_win", "https://www.vrbo.com/p_win", "normal");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(fetchCount, 1, "Fetch must be in flight");

    // 2. Insert rich policy into cache while fetch is still running
    const richPolicy = {
      schemaVersion: 1,
      propertyId: "p_win",
      source: "listing-page",
      petsAllowed: true,
      maxDogs: 2,
      weightLimit: { value: 50, unit: "lb", pounds: 50 },
      fee: { amount: 150, currency: "USD", period: "stay" },
    };
    await queue.setCached("p_win", { status: "ok", propertyId: "p_win", policy: richPolicy });

    // 3. Complete the in-flight fetch with a shallow candidate
    resolveFetch({
      ok: true,
      status: 200,
      text: async () => "<section>Dogs allowed</section>",
    });

    await new Promise((r) => setTimeout(r, 80));

    // 4. Assert fetch ran, cache retained rich policy, and subscriber received rich policy
    assert.equal(fetchCount, 1, "Fetch must have run");
    const cached = await queue.getCached("p_win");
    assert.equal(cached.policy.maxDogs, 2, "Cache must retain rich policy maxDogs");
    assert.ok(notifiedResult, "Subscriber must be notified");
    assert.equal(notifiedResult.policy.maxDogs, 2, "Subscriber must receive winning rich policy maxDogs");
    assert.equal(notifiedResult.policy.fee.amount, 150, "Subscriber must receive winning rich fee");

    queue.dispose();
  });

  await t.test("hover requests respect global minDelayMs request-start pacing", async () => {
    const startTimes = [];
    const mockFetch = async () => {
      startTimes.push(Date.now());
      await new Promise((r) => setTimeout(r, 20));
      return {
        ok: true,
        status: 200,
        text: async () => "<section>Dogs allowed</section>",
      };
    };

    const minDelayMs = 80;
    const queue = createSearchFetchQueue({
      fetchFn: mockFetch,
      maxConcurrent: 2,
      minDelayMs,
    });

    // Fire two high-priority hover requests consecutively
    queue.enqueue("hover_1", "https://www.vrbo.com/h1", "high");
    queue.enqueue("hover_2", "https://www.vrbo.com/h2", "high");

    await new Promise((r) => setTimeout(r, 250));
    assert.equal(startTimes.length, 2, "Both hover requests must be fetched");
    const gap = startTimes[1] - startTimes[0];
    assert.ok(gap >= minDelayMs - 15, `Expected gap >= ${minDelayMs - 15}ms, got ${gap}ms`);

    queue.dispose();
  });
});

test("page-bridge and extract currency exports", async (t) => {
  await t.test("extract.js exports formatCurrencyDisplay supporting non-USD currencies", () => {
    const extract = require("../extract.js");
    assert.equal(typeof extract.formatCurrencyDisplay, "function", "formatCurrencyDisplay must be exported");
    assert.equal(extract.formatCurrencyDisplay(100, "USD"), "$100");
    assert.equal(extract.formatCurrencyDisplay(75, "EUR"), "€75");
    assert.equal(extract.formatCurrencyDisplay(50, "GBP"), "£50");
    assert.equal(extract.formatCurrencyDisplay(120, "AUD"), "A$120");
    assert.equal(extract.formatCurrencyDisplay(80, "CAD"), "CA$80");
  });

  await t.test("parseListingHtml extracts detailed pet constraints from HTML body when Apollo has only shallow policy", () => {
    const fetcher = require("../search-fetcher.js");
    const extract = require("../extract.js");
    const html = `
      <html>
        <head>
          <script id="__APOLLO_STATE__">
            {
              "PropertyInfo:3880854": {
                "amenities": [{ "__ref": "Amenity:1" }]
              },
              "Amenity:1": {
                "header": "Pets",
                "section": "House Rules",
                "text": "Pets allowed"
              }
            }
          </script>
        </head>
        <body>
          <div class="about-property">
            <h2>About this property</h2>
            <p>• This home is pet-friendly.</p>
            <p>Up to 2 dogs allowed, max 50 lbs, $150 per pet fee.</p>
          </div>
        </body>
      </html>
    `;

    const parsed = fetcher.parseListingHtml(html, "3880854");
    assert.ok(parsed, "Parsed result must exist");
    assert.equal(parsed.propertyId, "3880854");
    assert.equal(parsed.policy.petsAllowed, true);
    assert.equal(parsed.policy.maxDogs, 2, "maxDogs must be extracted from HTML body");
    assert.equal(parsed.policy.weightLimit?.pounds, 50, "weightLimit must be extracted from HTML body");
    assert.equal(parsed.policy.fee?.amount, 150, "fee amount must be extracted from HTML body");

    const badge = extract.deriveSearchBadge(parsed.policy);
    assert.equal(badge.text, "Max 2 dogs allowed · 50 lbs · $150/pet");
  });

  await t.test("Class 12: Redirects and Canonicalization - resolves redirected canonical property ID and dual caches", async () => {
    const fetcher = require("../search-fetcher.js");
    const fakeStorage = new Map();
    const mockStorage = {
      get: (keys, cb) => {
        const res = {};
        for (const k of keys) if (fakeStorage.has(k)) res[k] = fakeStorage.get(k);
        cb(res);
      },
      set: (obj, cb) => {
        for (const [k, v] of Object.entries(obj)) fakeStorage.set(k, v);
        if (cb) cb();
      },
      remove: (keys, cb) => {
        for (const k of keys) fakeStorage.delete(k);
        if (cb) cb();
      },
    };

    let requestedFetchUrl = null;
    let requestedHeaders = null;
    const fetchFn = async (url, opts) => {
      requestedFetchUrl = url;
      requestedHeaders = opts.headers;
      return {
        ok: true,
        status: 200,
        url: "https://www.vrbo.com/9999999", // Redirected to canonical ID 9999999
        text: async () => `
          <html>
            <script id="__APOLLO_STATE__">
              {
                "PropertyInfo:9999999": {
                  "amenities": [{ "__ref": "Amenity:1" }]
                },
                "Amenity:1": {
                  "header": "Pets",
                  "text": "Up to 2 dogs allowed, max 50 lbs"
                }
              }
            </script>
          </html>
        `,
      };
    };

    const queue = fetcher.createSearchFetchQueue({
      fetchFn,
      storage: mockStorage,
      minDelayMs: 0,
      pacingDelayMs: 0,
    });

    const receivedNotifications = [];
    queue.subscribe("1111111", (data) => receivedNotifications.push(data));

    queue.enqueue("1111111", "https://www.vrbo.com/1111111", "high");
    await new Promise((r) => setTimeout(r, 60));

    assert.ok(requestedFetchUrl.includes("locale=en_US&siteid=1"), "Class 14: Must inject English locale params");
    assert.equal(requestedHeaders["Accept-Language"], "en-US,en;q=0.9", "Class 14: Must inject English Accept-Language header");

    assert.ok(receivedNotifications.length > 0, "Subscriber must receive policy notification");
    const result = receivedNotifications[0];
    assert.equal(result.status, "ok");
    assert.equal(result.policy.petsAllowed, true);
    assert.equal(result.policy.maxDogs, 2);

    // Verify alias cache (Class 10 & 12)
    const cachedCanonical = await queue.getCached("9999999");
    assert.ok(cachedCanonical, "Canonical ID must be cached directly");
    assert.equal(cachedCanonical.policy.maxDogs, 2);

    const cachedLegacy = await queue.getCached("1111111");
    assert.ok(cachedLegacy, "Legacy ID must be cached/aliased directly");
    assert.equal(cachedLegacy.policy.maxDogs, 2);

    queue.dispose();
  });

  await t.test("Class 11: Multi-Unit Hierarchy Pruning - ignores child unit rules when inspecting property level", () => {
    const fetcher = require("../search-fetcher.js");
    const html = `
      <html>
        <script id="__APOLLO_STATE__">
          {
            "PropertyInfo:100": {
              "amenities": [{ "__ref": "Amenity:1" }],
              "units": [{ "__ref": "Unit:200" }]
            },
            "Amenity:1": {
              "header": "Pets",
              "text": "Dogs allowed, max 2 dogs"
            },
            "Unit:200": {
              "__typename": "Unit",
              "amenities": [{ "__ref": "Amenity:2" }]
            },
            "Amenity:2": {
              "header": "Pets",
              "text": "No pets allowed in this unit"
            }
          }
        </script>
      </html>
    `;

    const parsed = fetcher.parseListingHtml(html, "100");
    assert.ok(parsed);
    assert.equal(parsed.policy.petsAllowed, true, "Property level rule (dogs allowed) must take precedence over pruned Unit child");
    assert.equal(parsed.policy.maxDogs, 2);
  });

  await t.test("Class 15: Split Apollo Entities - extracts bare fee and bare weight under explicit PetPolicy nodes", () => {
    const fetcher = require("../search-fetcher.js");
    const html = `
      <html>
        <script id="__APOLLO_STATE__">
          {
            "PropertyInfo:500": {
              "petPolicy": { "__ref": "PetPolicy:1" }
            },
            "PetPolicy:1": {
              "__typename": "PetPolicy",
              "fee": { "value": "$150" },
              "weight": { "value": "50 lbs" },
              "maxPets": { "value": "2" }
            }
          }
        </script>
      </html>
    `;

    const parsed = fetcher.parseListingHtml(html, "500");
    assert.ok(parsed);
    assert.equal(parsed.policy.petsAllowed, true);
    assert.equal(parsed.policy.maxDogs, 2, "Bare count under PetPolicy must be extracted");
    assert.equal(parsed.policy.weightLimit?.pounds, 50, "Bare weight under PetPolicy must be extracted");
    assert.equal(parsed.policy.fee?.amount, 150, "Bare fee under PetPolicy must be extracted");
  });
});

// ---------------------------------------------------------------------------
// Issue #20: one-sided jitter, adaptive error-cluster backoff, remove() API
// ---------------------------------------------------------------------------

const OK_HTML = "<section class=\"house-rules\"><h2>House Rules</h2><p>Dogs welcome, maximum 2 dogs.</p></section>";
const UNKNOWN_HTML = "<html><body>Nothing about animals here at all.</body></html>";

/** Fetch mock that records dispatch start times and returns a concrete pet policy. */
function makeTracingFetch(startTimes, bodyByUrl) {
  return async (url) => {
    startTimes.push({ t: Date.now(), url });
    const body = bodyByUrl ? bodyByUrl(url) : null;
    if (body) return body;
    return { ok: true, status: 200, text: async () => OK_HTML };
  };
}

function gaps(startTimes) {
  const out = [];
  for (let i = 1; i < startTimes.length; i++) out.push(startTimes[i].t - startTimes[i - 1].t);
  return out;
}

/** Drive the shared ladder up by `n` steps using 429 responses (hard pause disabled). */
async function raiseLadder(queue, n, prefix) {
  for (let i = 0; i < n; i++) {
    queue.enqueue(`${prefix}_429_${i}`, `https://www.vrbo.com/${prefix}429${i}`, "high");
    await new Promise((r) => setTimeout(r, 60));
  }
}

test("queue pacing: ladder base and effective delays (I10)", async (t) => {
  await t.test("DEFAULT_MIN_DELAY_MS is 800 and is the ladder base; the global floor is 250", () => {
    const queue = createSearchFetchQueue({ fetchFn: async () => ({ ok: true, status: 200, text: async () => OK_HTML }) });
    assert.equal(queue.getLadderStep(), 0);
    assert.equal(queue.getEffectiveMinDelayMs(), 800, "base delay must be 800ms at step 0");
    assert.equal(queue.getHighPriorityDelayMs(), 250, "high-priority floor must be 250ms at step 0");
    queue.dispose();
  });

  await t.test("ladder saturates at step 2: 800 -> 1600 -> 3200, never 6400", async () => {
    const queue = createSearchFetchQueue({
      fetchFn: async () => ({ ok: false, status: 429 }),
      maxConcurrent: 1,
      minDelayMs: 5,
      pauseOnChallengeMs: 0,
      cooldownMs: 0,
    });

    const seen = [];
    for (let i = 0; i < 5; i++) {
      queue.enqueue(`sat_${i}`, `https://www.vrbo.com/sat${i}`, "high");
      await new Promise((r) => setTimeout(r, 50));
      seen.push(queue.getLadderStep());
    }

    assert.deepEqual(seen, [1, 2, 2, 2, 2], `Ladder must saturate at 2, got ${JSON.stringify(seen)}`);
    queue.dispose();

    // Same saturation expressed at production constants: the cap is on the floor.
    const prod = createSearchFetchQueue({
      fetchFn: async () => ({ ok: false, status: 429 }),
      maxConcurrent: 1,
      pauseOnChallengeMs: 0,
      cooldownMs: 0,
    });
    for (let i = 0; i < 4; i++) {
      prod.enqueue(`psat_${i}`, `https://www.vrbo.com/psat${i}`, "high");
      await new Promise((r) => setTimeout(r, 320));
    }
    assert.equal(prod.getLadderStep(), 2);
    assert.equal(prod.getEffectiveMinDelayMs(), 3200, "effective floor must never exceed 3200ms");
    assert.equal(prod.getHighPriorityDelayMs(), 1000, "global floor must never exceed 1000ms");
    prod.dispose();
  });
});

test("queue pacing: one-sided jitter (I4a)", async (t) => {
  await t.test("observed spacing stays within [floor, floor * 1.3] across N samples and never below the floor", async () => {
    const starts = [];
    const floor = 90;
    const queue = createSearchFetchQueue({
      fetchFn: makeTracingFetch(starts),
      maxConcurrent: 1,
      minDelayMs: floor,
      highPriorityFloorMs: floor, // collapse the global term onto the class term
    });

    for (let i = 1; i <= 8; i++) queue.enqueue(`j_${i}`, `https://www.vrbo.com/j${i}`);
    await new Promise((r) => setTimeout(r, 8 * floor * 1.3 + 500));

    assert.ok(starts.length >= 6, `Expected >= 6 samples, got ${starts.length}`);
    for (const g of gaps(starts)) {
      assert.ok(g >= floor - 10, `Jitter must never fire below the floor: got ${g}ms < ${floor}ms`);
      assert.ok(g <= floor * 1.3 + 45, `Jitter must not exceed floor * 1.3: got ${g}ms`);
    }
    queue.dispose();
  });

  await t.test("jitter is one-sided: randomFn 0 lands on the floor, randomFn 1 lands on floor * 1.3", async () => {
    const floor = 120;

    const lowStarts = [];
    const low = createSearchFetchQueue({
      fetchFn: makeTracingFetch(lowStarts),
      maxConcurrent: 1,
      minDelayMs: floor,
      highPriorityFloorMs: floor,
      randomFn: () => 0,
    });
    low.enqueue("jl_1", "https://www.vrbo.com/jl1");
    low.enqueue("jl_2", "https://www.vrbo.com/jl2");
    await new Promise((r) => setTimeout(r, 450));
    assert.equal(lowStarts.length, 2);
    const lowGap = lowStarts[1].t - lowStarts[0].t;
    assert.ok(lowGap >= floor - 10, `randomFn()=0 must not fire below the floor, got ${lowGap}ms`);
    assert.ok(lowGap < floor * 1.2, `randomFn()=0 must land at the floor, got ${lowGap}ms`);
    low.dispose();

    const highStarts = [];
    const high = createSearchFetchQueue({
      fetchFn: makeTracingFetch(highStarts),
      maxConcurrent: 1,
      minDelayMs: floor,
      highPriorityFloorMs: floor,
      randomFn: () => 1,
    });
    high.enqueue("jh_1", "https://www.vrbo.com/jh1");
    high.enqueue("jh_2", "https://www.vrbo.com/jh2");
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(highStarts.length, 2);
    const highGap = highStarts[1].t - highStarts[0].t;
    assert.ok(
      highGap >= floor * 1.3 - 15 && highGap <= floor * 1.3 + 45,
      `randomFn()=1 must land at floor * 1.3 (${floor * 1.3}ms), got ${highGap}ms`
    );
    high.dispose();
  });

  await t.test("jitter composes with the ladder: at ladderStep 1 it is measured against 2x the base", async () => {
    const starts = [];
    const base = 100;
    const queue = createSearchFetchQueue({
      fetchFn: makeTracingFetch(starts, (url) => (url.includes("429") ? { ok: false, status: 429 } : null)),
      maxConcurrent: 1,
      minDelayMs: base,
      highPriorityFloorMs: base,
      pauseOnChallengeMs: 0,
      cooldownMs: 0,
      randomFn: () => 1, // maximum jitter
    });

    await raiseLadder(queue, 1, "lad");
    assert.equal(queue.getLadderStep(), 1);
    assert.equal(queue.getEffectiveMinDelayMs(), base * 2);

    starts.length = 0;
    queue.enqueue("lc_1", "https://www.vrbo.com/lc1");
    queue.enqueue("lc_2", "https://www.vrbo.com/lc2");
    await new Promise((r) => setTimeout(r, 900));

    assert.equal(starts.length, 2, "both items must dispatch");
    const gap = starts[1].t - starts[0].t;
    assert.ok(gap >= base * 2 - 10, `Spacing must be gated by the laddered floor (>= ${base * 2}ms), got ${gap}ms`);
    assert.ok(gap <= base * 2 * 1.3 + 50, `Spacing must stay within laddered floor * 1.3, got ${gap}ms`);
    assert.ok(gap > base * 1.3 + 20, `Spacing must NOT be measured against the un-laddered base, got ${gap}ms`);
    queue.dispose();
  });
});

test("queue pacing: ladder advancement and recovery (I1 + I5)", async (t) => {
  await t.test("a 429 sets pausedUntil AND advances ladderStep, exactly once for the single event", async () => {
    const queue = createSearchFetchQueue({
      fetchFn: async () => ({ ok: false, status: 429 }),
      maxConcurrent: 1,
      minDelayMs: 5,
      pauseOnChallengeMs: 1000,
      cooldownMs: 0,
    });

    assert.equal(queue.getLadderStep(), 0);
    assert.equal(queue.isPaused(), false);

    queue.enqueue("hb_1", "https://www.vrbo.com/hb1", "high");
    await new Promise((r) => setTimeout(r, 70));

    assert.equal(queue.isPaused(), true, "429 must set the hard pause");
    assert.equal(queue.getLadderStep(), 1, "429 must advance the ladder exactly once, not twice");
    assert.equal(queue.getEffectiveMinDelayMs(), 10);
    queue.dispose();
  });

  await t.test("a bot-challenge body is one event too: one pause, one ladder step", async () => {
    const queue = createSearchFetchQueue({
      fetchFn: async () => ({
        ok: true,
        status: 200,
        text: async () => "<html><head><title>Bot or Not?</title></head><body>challenge-running</body></html>",
      }),
      maxConcurrent: 1,
      minDelayMs: 5,
      pauseOnChallengeMs: 1000,
      cooldownMs: 0,
    });

    queue.enqueue("ch_1", "https://www.vrbo.com/ch1", "high");
    await new Promise((r) => setTimeout(r, 70));

    assert.equal(queue.isPaused(), true);
    assert.equal(queue.getLadderStep(), 1, "one challenge must advance the ladder exactly once");
    queue.dispose();
  });

  await t.test("cluster gate: one timeout does not advance the ladder, three within the window do", async () => {
    let attempts = 0;
    const queue = createSearchFetchQueue({
      fetchFn: async () => {
        attempts++;
        const err = new Error("Aborted");
        err.name = "AbortError";
        throw err;
      },
      maxConcurrent: 1,
      minDelayMs: 5,
      cooldownMs: 0,
      errorClusterThreshold: 3,
      errorClusterWindowMs: 60000,
    });

    queue.enqueue("to_1", "https://www.vrbo.com/to1", "high");
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(queue.getLadderStep(), 0, "a single timeout must not escalate");

    queue.enqueue("to_2", "https://www.vrbo.com/to2", "high");
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(queue.getLadderStep(), 0, "two timeouts must not escalate");

    queue.enqueue("to_3", "https://www.vrbo.com/to3", "high");
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(queue.getLadderStep(), 1, "three timeouts within the window must escalate once");
    assert.equal(attempts, 3);
    queue.dispose();
  });

  await t.test("cluster gate: 5xx feeds the same cluster, and failures spread beyond the window do not", async () => {
    const queue = createSearchFetchQueue({
      fetchFn: async () => ({ ok: false, status: 503 }),
      maxConcurrent: 1,
      minDelayMs: 5,
      cooldownMs: 0,
      errorClusterThreshold: 3,
      errorClusterWindowMs: 80,
    });

    queue.enqueue("e5_1", "https://www.vrbo.com/e51", "high");
    await new Promise((r) => setTimeout(r, 140)); // ages out of the window
    queue.enqueue("e5_2", "https://www.vrbo.com/e52", "high");
    await new Promise((r) => setTimeout(r, 25));
    queue.enqueue("e5_3", "https://www.vrbo.com/e53", "high");
    await new Promise((r) => setTimeout(r, 25));

    assert.equal(queue.getLadderStep(), 0, "failures spread beyond the window must not form a cluster");

    queue.enqueue("e5_4", "https://www.vrbo.com/e54", "high");
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(queue.getLadderStep(), 1, "three 5xx inside the window must escalate");
    queue.dispose();
  });

  await t.test("`unknown` is inert: it neither advances the ladder nor resets the clean window", async () => {
    const queue = createSearchFetchQueue({
      fetchFn: async (url) => {
        if (url.includes("429")) return { ok: false, status: 429 };
        if (url.includes("okpolicy")) return { ok: true, status: 200, text: async () => OK_HTML };
        return { ok: true, status: 200, text: async () => UNKNOWN_HTML };
      },
      maxConcurrent: 1,
      minDelayMs: 5,
      pauseOnChallengeMs: 0,
      cooldownMs: 0,
      cleanWindowMs: 200,
    });

    await raiseLadder(queue, 1, "unk");
    assert.equal(queue.getLadderStep(), 1);

    // A run of `unknown` results spanning more than one clean window.
    for (let i = 0; i < 5; i++) {
      queue.enqueue(`u_${i}`, `https://www.vrbo.com/u${i}`, "high");
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(queue.getLadderStep(), 1, "an unknown result must not advance the ladder");
    }

    // The clean window survived the unknowns, so the next real success steps down.
    queue.enqueue("u_ok", "https://www.vrbo.com/okpolicy", "high");
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(queue.getLadderStep(), 0, "unknown results must not have reset the clean window");
    queue.dispose();
  });

  await t.test("recovery is asymmetric: one success does not step down, a sustained clean window does", async () => {
    const queue = createSearchFetchQueue({
      fetchFn: async (url) => (url.includes("429")
        ? { ok: false, status: 429 }
        : { ok: true, status: 200, text: async () => OK_HTML }),
      maxConcurrent: 1,
      minDelayMs: 5,
      pauseOnChallengeMs: 0,
      cooldownMs: 0,
      cleanWindowMs: 300,
    });

    await raiseLadder(queue, 1, "rec");
    assert.equal(queue.getLadderStep(), 1);

    queue.enqueue("r_ok1", "https://www.vrbo.com/rok1", "high");
    await new Promise((r) => setTimeout(r, 70));
    assert.equal(queue.getLadderStep(), 1, "a single success must not step the ladder down");

    await new Promise((r) => setTimeout(r, 320));
    queue.enqueue("r_ok2", "https://www.vrbo.com/rok2", "high");
    await new Promise((r) => setTimeout(r, 70));
    assert.equal(queue.getLadderStep(), 0, "a sustained clean window must step the ladder down");
    queue.dispose();
  });

  await t.test("both floors return to base only after the shared clean window, one step per window", async () => {
    const queue = createSearchFetchQueue({
      fetchFn: async (url) => (url.includes("429")
        ? { ok: false, status: 429 }
        : { ok: true, status: 200, text: async () => OK_HTML }),
      maxConcurrent: 1,
      minDelayMs: 100,
      highPriorityFloorMs: 25,
      pauseOnChallengeMs: 0,
      cooldownMs: 0,
      cleanWindowMs: 250,
    });

    await raiseLadder(queue, 2, "two");
    assert.equal(queue.getLadderStep(), 2);
    assert.equal(queue.getEffectiveMinDelayMs(), 400, "background floor scales 4x at step 2");
    assert.equal(queue.getHighPriorityDelayMs(), 100, "global floor scales 4x at step 2");

    await new Promise((r) => setTimeout(r, 280));
    queue.enqueue("t_ok1", "https://www.vrbo.com/tok1", "high");
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(queue.getLadderStep(), 1, "first clean window steps 2 -> 1");

    await new Promise((r) => setTimeout(r, 280));
    queue.enqueue("t_ok2", "https://www.vrbo.com/tok2", "high");
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(queue.getLadderStep(), 0, "second clean window steps 1 -> 0");
    assert.equal(queue.getEffectiveMinDelayMs(), 100);
    assert.equal(queue.getHighPriorityDelayMs(), 25);
    queue.dispose();
  });
});

test("queue pacing: remove() API (I8a)", async (t) => {
  await t.test("regression: enqueue -> remove -> re-enqueue is not locked out by enqueuedOrActive", async () => {
    const starts = [];
    const queue = createSearchFetchQueue({
      fetchFn: makeTracingFetch(starts),
      maxConcurrent: 1,
      minDelayMs: 5,
      cooldownMs: 0,
    });

    queue.enqueue("lock_1", "https://www.vrbo.com/lock1");
    assert.equal(queue.remove("lock_1"), true, "remove() must report the cancellation");
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(starts.length, 0, "a removed item must never dispatch");

    // enqueue() early-returns on enqueuedOrActive.has(id), so a remove() that only
    // spliced the queue array would block this property for the rest of the session.
    queue.enqueue("lock_1", "https://www.vrbo.com/lock1");
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(starts.length, 1, "re-enqueue after remove() must succeed");
    assert.ok(starts[0].url.includes("lock1"));
    queue.dispose();
  });

  await t.test("removes only the target; untargeted items still dispatch", async () => {
    const starts = [];
    const queue = createSearchFetchQueue({
      fetchFn: makeTracingFetch(starts),
      maxConcurrent: 1,
      minDelayMs: 120,
      highPriorityFloorMs: 120,
    });

    queue.enqueue("rm_a", "https://www.vrbo.com/rma");
    queue.enqueue("rm_b", "https://www.vrbo.com/rmb");
    queue.enqueue("rm_c", "https://www.vrbo.com/rmc");
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(queue.remove("rm_b"), true);
    await new Promise((r) => setTimeout(r, 800));

    const urls = starts.map((s) => s.url);
    assert.ok(urls.some((u) => u.includes("rma")), "untargeted item rm_a must still dispatch");
    assert.ok(urls.some((u) => u.includes("rmc")), "untargeted item rm_c must still dispatch");
    assert.ok(!urls.some((u) => u.includes("rmb")), "removed item rm_b must never dispatch");
    queue.dispose();
  });

  await t.test("returns false for unknown ids and for in-flight ids", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const queue = createSearchFetchQueue({
      fetchFn: async () => {
        await gate;
        return { ok: true, status: 200, text: async () => OK_HTML };
      },
      maxConcurrent: 1,
      minDelayMs: 5,
    });

    assert.equal(queue.remove("never_seen"), false, "unknown id must return false");
    assert.equal(queue.remove(null), false, "missing id must return false");

    queue.enqueue("inflight_1", "https://www.vrbo.com/if1");
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(queue.getActiveCount(), 1, "item must be in flight");
    assert.equal(queue.remove("inflight_1"), false, "an in-flight id must return false");

    release();
    await new Promise((r) => setTimeout(r, 60));
    queue.dispose();
  });

  await t.test("remove() preserves the session budget and leaves clearQueue() semantics intact", async () => {
    const queue = createSearchFetchQueue({
      fetchFn: async () => ({ ok: true, status: 200, text: async () => OK_HTML }),
      maxConcurrent: 1,
      minDelayMs: 5,
      cooldownMs: 0,
    });

    queue.enqueue("sb_1", "https://www.vrbo.com/sb1");
    await new Promise((r) => setTimeout(r, 80));
    const spent = queue.getSessionCount();
    assert.ok(spent >= 1, "one request must have been spent");

    queue.enqueue("sb_2", "https://www.vrbo.com/sb2");
    assert.equal(queue.remove("sb_2"), true);
    assert.equal(queue.getSessionCount(), spent, "remove() must not reset sessionRequestsCount");

    queue.clearQueue();
    assert.equal(queue.getSessionCount(), 0, "clearQueue() must still reset the session budget");
    assert.equal(queue.getQueueLength(), 0);
    queue.dispose();
  });
});

test("queue pacing: amendments to issue #20", async (t) => {
  await t.test("404 is fully inert: a run of 404s neither advances the ladder nor blocks a later clean-window step-down", async () => {
    const queue = createSearchFetchQueue({
      fetchFn: async (url) => {
        if (url.includes("429")) return { ok: false, status: 429 };
        if (url.includes("okpolicy")) return { ok: true, status: 200, text: async () => OK_HTML };
        return { ok: false, status: 404 };
      },
      maxConcurrent: 1,
      minDelayMs: 5,
      pauseOnChallengeMs: 0,
      cooldownMs: 0,
      cleanWindowMs: 200,
    });

    await raiseLadder(queue, 1, "nf");
    assert.equal(queue.getLadderStep(), 1);

    // A scatter of delisted properties, spanning more than one clean window.
    for (let i = 0; i < 5; i++) {
      queue.enqueue(`nf_${i}`, `https://www.vrbo.com/nf${i}`, "high");
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(queue.getLadderStep(), 1, "a 404 must not advance the ladder");
    }

    // A 404 proves the server is healthy, so the clean window is intact and the
    // next real success steps the ladder down.
    queue.enqueue("nf_ok", "https://www.vrbo.com/okpolicy", "high");
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(queue.getLadderStep(), 0, "404s must not have reset the clean window");
    queue.dispose();
  });

  await t.test("404s never form an error cluster no matter how many arrive", async () => {
    const queue = createSearchFetchQueue({
      fetchFn: async () => ({ ok: false, status: 404 }),
      maxConcurrent: 1,
      minDelayMs: 5,
      cooldownMs: 0,
      errorClusterThreshold: 3,
      errorClusterWindowMs: 60000,
    });

    for (let i = 0; i < 6; i++) {
      queue.enqueue(`cl_${i}`, `https://www.vrbo.com/cl${i}`, "high");
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.equal(queue.getLadderStep(), 0, "six 404s must not cluster into a ladder step");
    queue.dispose();
  });

  await t.test("remove() during the staged-enqueue window cancels the pending push and does not lock the id out", async () => {
    const starts = [];
    // Storage whose lookup resolves on a timer, so the enqueue stays staged
    // (in enqueuedOrActive, not yet pushed to `queue`) for a controllable window.
    const slowStorage = {
      get(_keys, cb) { setTimeout(() => cb({}), 120); },
      set(_items, cb) { if (cb) cb(); },
      remove(_keys, cb) { if (cb) cb(); },
    };

    const queue = createSearchFetchQueue({
      fetchFn: makeTracingFetch(starts),
      storage: slowStorage,
      autoMaintenance: false,
      maxConcurrent: 1,
      minDelayMs: 5,
      cooldownMs: 0,
    });

    queue.enqueue("staged_1", "https://www.vrbo.com/staged1");
    await new Promise((r) => setTimeout(r, 30)); // lookup still in flight
    assert.equal(queue.getQueueLength(), 0, "item must still be staged, not yet pushed to the queue");

    // remove() lands BEFORE getCached() resolves.
    assert.equal(queue.remove("staged_1"), true, "remove() must cancel a staged enqueue");

    await new Promise((r) => setTimeout(r, 250)); // lookup resolves during this wait
    assert.equal(queue.getQueueLength(), 0, "the resolved lookup must not push a removed item");
    assert.equal(starts.length, 0, "a staged-then-removed item must never dispatch");

    // (b) the id must not be locked out of enqueueing afterwards.
    queue.enqueue("staged_1", "https://www.vrbo.com/staged1");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(starts.length, 1, "re-enqueue after a staged-window remove() must succeed");
    assert.ok(starts[0].url.includes("staged1"));
    queue.dispose();
  });

  await t.test("re-enqueue inside the staged window dispatches exactly once, not twice", async () => {
    const starts = [];
    const slowStorage = {
      get(_keys, cb) { setTimeout(() => cb({}), 120); },
      set(_items, cb) { if (cb) cb(); },
      remove(_keys, cb) { if (cb) cb(); },
    };

    const queue = createSearchFetchQueue({
      fetchFn: makeTracingFetch(starts),
      storage: slowStorage,
      autoMaintenance: false,
      maxConcurrent: 1,
      minDelayMs: 5,
      cooldownMs: 0,
    });

    // enqueue -> remove -> enqueue, all before the first lookup resolves. The
    // stale lookup must be discarded by its token rather than pushing a duplicate.
    queue.enqueue("race_1", "https://www.vrbo.com/race1");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(queue.remove("race_1"), true);
    queue.enqueue("race_1", "https://www.vrbo.com/race1");

    await new Promise((r) => setTimeout(r, 400));
    assert.equal(starts.length, 1, `Expected exactly one dispatch, got ${starts.length}`);
    queue.dispose();
  });

  await t.test("bounded LRU memory cache limits entries and evicts oldest items", async () => {
    const queue = createSearchFetchQueue({
      maxMemoryEntries: 3,
      autoMaintenance: false,
    });

    const dummyPolicy = { schemaVersion: 1, petsAllowed: true };
    await queue.setCached("prop_1", { status: "ok", policy: dummyPolicy });
    await queue.setCached("prop_2", { status: "ok", policy: dummyPolicy });
    await queue.setCached("prop_3", { status: "ok", policy: dummyPolicy });

    assert.equal(queue.getMemoryCacheSize(), 3);
    assert.ok(await queue.getCached("prop_1"));

    // Adding a 4th entry should evict prop_2 (since prop_1 was just read and moved to MRU)
    await queue.setCached("prop_4", { status: "ok", policy: dummyPolicy });
    assert.equal(queue.getMemoryCacheSize(), 3);
    assert.ok(await queue.getCached("prop_1"), "prop_1 was refreshed and should remain in cache");
    assert.ok(await queue.getCached("prop_3"), "prop_3 should remain in cache");
    assert.ok(await queue.getCached("prop_4"), "prop_4 should be in cache");
    assert.equal(await queue.getCached("prop_2"), null, "prop_2 should have been evicted as oldest");

    queue.dispose();
  });

  await t.test("expired in-memory cache entries are evicted upon read", async () => {
    const queue = createSearchFetchQueue({
      ttlMs: 50,
      autoMaintenance: false,
    });

    const dummyPolicy = { schemaVersion: 1, petsAllowed: true };
    await queue.setCached("prop_expire", { status: "ok", policy: dummyPolicy });
    assert.equal(queue.getMemoryCacheSize(), 1);

    await new Promise((r) => setTimeout(r, 70));
    const cached = await queue.getCached("prop_expire");
    assert.equal(cached, null, "Expired cache entry should return null");
    assert.equal(queue.getMemoryCacheSize(), 0, "Expired entry should be evicted from memoryCache");

    queue.dispose();
  });

  await t.test("Issue #23: scroll-velocity pause halts normal dispatch and preserves pacing/ladder state", async () => {
    let fetchCalls = 0;
    const fetchFn = async () => {
      fetchCalls++;
      return {
        ok: true,
        status: 200,
        text: async () => "<html><body>Dogs allowed</body></html>",
      };
    };

    const queue = createSearchFetchQueue({
      fetchFn,
      minDelayMs: 100,
      highPriorityFloorMs: 50,
      autoMaintenance: false,
    });

    const initialStep = queue.getLadderStep();
    const initialPaused = queue.isPaused();

    // 1. Enqueue items and immediately pause scroll
    queue.setScrollPaused(true);
    assert.equal(queue.isScrollPaused(), true);

    queue.enqueue("prop_1", "https://www.vrbo.com/111", "normal");
    queue.enqueue("prop_2", "https://www.vrbo.com/222", "normal");

    // Wait past the minDelayMs window
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(fetchCalls, 0, "Normal priority items must not dispatch while scrollPaused is true");
    assert.equal(queue.getQueueLength(), 2, "Items should remain queued while scroll paused");

    // Ladder and pausedUntil invariants must be preserved
    assert.equal(queue.getLadderStep(), initialStep, "Scroll pause must not advance the ladder");
    assert.equal(queue.isPaused(), initialPaused, "Scroll pause must not set pausedUntil");

    // 2. High-priority item cuts through even when scroll is paused
    queue.enqueue("prop_hp", "https://www.vrbo.com/333", "high");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(fetchCalls, 1, "High priority item must dispatch even when scroll is paused");
    assert.equal(queue.getQueueLength(), 2, "Normal items must still remain paused in queue");

    // 3. Resume scroll -> queue drains
    queue.setScrollPaused(false);
    assert.equal(queue.isScrollPaused(), false);
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(fetchCalls, 3, "Queue should drain normal items once scroll resumes");

    queue.dispose();
  });

  await t.test("Issue #23: idle scheduling defers entry-point dispatch and cancels on high-priority arrival", async () => {
    let idleCallbacks = [];
    let cancelledHandles = [];
    let nextHandle = 1;

    const requestIdleCallbackFn = (cb, opts) => {
      const handle = nextHandle++;
      idleCallbacks.push({ handle, cb, opts });
      return handle;
    };

    const cancelIdleCallbackFn = (handle) => {
      cancelledHandles.push(handle);
      idleCallbacks = idleCallbacks.filter((item) => item.handle !== handle);
    };

    let fetchCalls = 0;
    const fetchFn = async () => {
      fetchCalls++;
      return {
        ok: true,
        status: 200,
        text: async () => "<html><body>Dogs allowed</body></html>",
      };
    };

    const queue = createSearchFetchQueue({
      fetchFn,
      maxConcurrent: 1,
      minDelayMs: 50,
      highPriorityFloorMs: 25,
      idleCallbackTimeoutMs: 1000,
      requestIdleCallbackFn,
      cancelIdleCallbackFn,
      autoMaintenance: false,
    });

    // 1. Enqueue normal item: should schedule via requestIdleCallbackFn with timeout 1000
    queue.enqueue("prop_normal", "https://www.vrbo.com/111", "normal");
    await new Promise((r) => setTimeout(r, 10)); // let staging getCached resolve

    assert.equal(idleCallbacks.length, 1, "Should have scheduled 1 idle callback for normal enqueue");
    assert.equal(idleCallbacks[0].opts.timeout, 1000, "Should specify timeout: 1000");
    assert.equal(fetchCalls, 0, "Fetch should not dispatch before idle callback executes");

    // 2. High-priority enqueue arrives: should cancel the pending idle callback and dispatch synchronously
    const pendingHandle = idleCallbacks[0].handle;
    queue.enqueue("prop_hp", "https://www.vrbo.com/222", "high");
    await new Promise((r) => setTimeout(r, 10));

    assert.ok(cancelledHandles.includes(pendingHandle), "High-priority arrival must cancel pending idle callback");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fetchCalls, 1, "High-priority item should have dispatched immediately");

    // 3. Executing remaining idle callback drains normal work
    if (idleCallbacks.length > 0) {
      const remaining = idleCallbacks.shift();
      remaining.cb({ didTimeout: true, timeRemaining: () => 0 });
    }
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(fetchCalls, 2, "Normal item should dispatch when idle callback runs");

    queue.dispose();
  });

  await t.test("Issue #23: dispose cancels pending idle callback handle", async () => {
    let cancelled = false;
    const requestIdleCallbackFn = () => 42;
    const cancelIdleCallbackFn = (handle) => {
      if (handle === 42) cancelled = true;
    };

    const queue = createSearchFetchQueue({
      requestIdleCallbackFn,
      cancelIdleCallbackFn,
      autoMaintenance: false,
    });

    queue.enqueue("prop_test", "https://www.vrbo.com/111", "normal");
    await new Promise((r) => setTimeout(r, 10));

    queue.dispose();
    assert.equal(cancelled, true, "dispose() must cancel pending idle callback handle");
  });

  await t.test("Issue #23: mid-drain scroll pause halts remaining queued items and resumes seamlessly", async () => {
    let fetchCalls = 0;
    const fetchFn = async () => {
      fetchCalls++;
      return {
        ok: true,
        status: 200,
        text: async () => "<html><body>Dogs allowed</body></html>",
      };
    };

    const queue = createSearchFetchQueue({
      fetchFn,
      maxConcurrent: 1,
      minDelayMs: 60,
      autoMaintenance: false,
    });

    // Enqueue 4 items
    queue.enqueue("prop_mid_1", "https://www.vrbo.com/1");
    queue.enqueue("prop_mid_2", "https://www.vrbo.com/2");
    queue.enqueue("prop_mid_3", "https://www.vrbo.com/3");
    queue.enqueue("prop_mid_4", "https://www.vrbo.com/4");

    // Wait for the first item to dispatch
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(fetchCalls, 1, "First item should dispatch");

    // Now pause scrolling mid-drain while items 2, 3, 4 are still queued
    queue.setScrollPaused(true);
    assert.equal(queue.isScrollPaused(), true);

    // Wait past multiple pacing intervals (150ms)
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(fetchCalls, 1, "Queue must halt mid-drain and not dispatch items 2, 3, 4 while scrollPaused is true");
    assert.equal(queue.getQueueLength(), 3, "Items 2, 3, 4 should remain in queue");

    // Resume scrolling
    queue.setScrollPaused(false);
    assert.equal(queue.isScrollPaused(), false);

    // Wait for remaining items to drain across their paced intervals
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(fetchCalls, 4, "All 4 items should have dispatched after resuming");
    assert.equal(queue.getQueueLength(), 0, "Queue should be completely drained");

    queue.dispose();
  });
});

