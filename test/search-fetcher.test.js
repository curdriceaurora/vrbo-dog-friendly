// test/search-fetcher.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseListingHtml, createSearchFetchQueue } = require("../search-fetcher.js");

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
});
