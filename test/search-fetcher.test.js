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

  await t.test("parses embedded Apollo state in HTML", () => {
    const apolloState = {
      "PropertyInfo:12345": {
        rules: {
          header: "House Rules",
          section: "Rules",
          text: "Dogs welcome, maximum 2 dogs under 50 lbs. $150 pet fee applies."
        }
      }
    };
    const html = `<html><script>window.__APOLLO_STATE__ = ${JSON.stringify(apolloState)};</script></html>`;
    const res = parseListingHtml(html, "12345");
    assert.equal(res.ok, true);
    assert.equal(res.policy.petsAllowed, true);
    assert.equal(res.policy.maxDogs, 2);
    assert.equal(res.policy.weightPerDog, "50 lbs");
    assert.equal(res.policy.fee, "$150");
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
    assert.equal(res.policy.fee, "$75");
  });

  await t.test("returns null for empty or irrelevant HTML", () => {
    const html = "<html><body><h1>Page Not Found</h1></body></html>";
    const res = parseListingHtml(html, "00000");
    assert.equal(res, null);
  });
});

test("search-fetcher queue and caching", async (t) => {
  await t.test("respects concurrency and notifies subscribers", async () => {
    const fetchedUrls = [];
    const mockFetch = async (url) => {
      fetchedUrls.push(url);
      await new Promise((r) => setTimeout(r, 50));
      return {
        ok: true,
        status: 200,
        text: async () => `
          <section>
            <h2>House Rules</h2>
            <p>Dogs are allowed. Maximum of 2 dogs allowed.</p>
          </section>
        `,
      };
    };

    const mockStorage = {
      store: {},
      get(keys, cb) {
        const res = {};
        for (const k of keys) {
          if (this.store[k]) res[k] = this.store[k];
        }
        cb(res);
      },
      set(obj) {
        Object.assign(this.store, obj);
      },
    };

    const queue = createSearchFetchQueue({
      fetchFn: mockFetch,
      storage: mockStorage,
      maxConcurrent: 2,
      minDelayMs: 10,
    });

    const results = new Map();
    queue.subscribe("prop1", (data) => results.set("prop1", data));
    queue.subscribe("prop2", (data) => results.set("prop2", data));

    queue.enqueue("prop1", "https://www.vrbo.com/111");
    queue.enqueue("prop2", "https://www.vrbo.com/222");

    await new Promise((r) => setTimeout(r, 200));

    assert.equal(results.get("prop1")?.status, "ok");
    assert.equal(results.get("prop1")?.policy.maxDogs, 2);
    assert.equal(results.get("prop2")?.status, "ok");
    assert.equal(fetchedUrls.length, 2);

    // Test cache hit: third request for prop1 should not call fetchFn again
    const cachedData = await queue.getCached("prop1");
    assert.equal(cachedData.status, "ok");
    assert.equal(cachedData.policy.maxDogs, 2);

    queue.enqueue("prop1", "https://www.vrbo.com/111");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fetchedUrls.length, 2); // No new network call
  });

  await t.test("pauses queue on 429 rate limit response", async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return {
        ok: false,
        status: 429,
      };
    };

    const queue = createSearchFetchQueue({
      fetchFn: mockFetch,
      maxConcurrent: 1,
      minDelayMs: 10,
    });

    let resultReceived = null;
    queue.subscribe("rate_limited_prop", (data) => {
      resultReceived = data;
    });

    queue.enqueue("rate_limited_prop", "https://www.vrbo.com/429");
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(resultReceived?.status, "rate_limited");
    assert.equal(queue.isPaused(), true);
  });

  await t.test("prioritizes high-priority items", async () => {
    const executionOrder = [];
    const mockFetch = async (url) => {
      executionOrder.push(url);
      await new Promise((r) => setTimeout(r, 30));
      return {
        ok: true,
        status: 200,
        text: async () => "<section>House Rules: Dogs allowed</section>",
      };
    };

    const queue = createSearchFetchQueue({
      fetchFn: mockFetch,
      maxConcurrent: 1,
      minDelayMs: 20,
    });

    queue.enqueue("item1", "https://www.vrbo.com/1", "normal");
    queue.enqueue("item2", "https://www.vrbo.com/2", "normal");
    queue.enqueue("item3_high", "https://www.vrbo.com/3", "high");

    await new Promise((r) => setTimeout(r, 250));

    // item1 starts first, then item3_high should be processed before item2
    assert.equal(executionOrder[0], "https://www.vrbo.com/1");
    assert.equal(executionOrder[1], "https://www.vrbo.com/3");
    assert.equal(executionOrder[2], "https://www.vrbo.com/2");
  });
});
