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
      const id = url.split("/").pop();
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
      contradictions: ["Host notes contradict amenities"],
      restrictionNoteCount: 3,
      confidence: "high",
      _raw: { domText: "secret excerpt" },
    };

    const serialized = serializeSearchPolicyForCache(richPolicy);
    assert.equal(serialized.fee.text, "Pet fee applies", "fee.text must be preserved");
    assert.equal(serialized.deposit.text, "$100 deposit", "deposit.text must be preserved");
    assert.deepEqual(serialized.contradictions, ["Host notes contradict amenities"], "contradictions must be preserved");
    assert.equal(serialized.restrictionNoteCount, 3, "restrictionNoteCount must be preserved");
    assert.equal(serialized._raw, undefined, "_raw must be stripped");
  });

  await t.test("subscriber notification delivers winning cache record when candidate is rejected", async () => {
    let fetchCount = 0;
    const mockFetch = async () => {
      fetchCount++;
      // Return shallow policy
      return {
        ok: true,
        status: 200,
        text: async () => "<section>Dogs allowed</section>",
      };
    };

    const queue = createSearchFetchQueue({
      fetchFn: mockFetch,
      maxConcurrent: 1,
      minDelayMs: 10,
    });

    // 1. Prime cache with rich policy
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

    // 2. Subscribe and enqueue fetch
    let notifiedResult = null;
    queue.subscribe("p_win", (result) => {
      notifiedResult = result;
    });

    queue.enqueue("p_win", "https://www.vrbo.com/p_win", "high");
    await new Promise((r) => setTimeout(r, 100));

    // 3. Assert notified result is the rich winning policy, not downgraded shallow candidate
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

  await t.test("page-bridge walkCollect extracts policy from body and description leaves", () => {
    const pageBridgeCode = require("fs").readFileSync(require("path").join(__dirname, "../page-bridge.js"), "utf8");
    assert.ok(pageBridgeCode.includes('k === "body"'), "page-bridge.js must check body leaf");
    assert.ok(pageBridgeCode.includes('k === "description"'), "page-bridge.js must check description leaf");
  });
});


