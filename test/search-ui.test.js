// test/search-ui.test.js
// Unit tests for search-fetcher AbortController, request timeouts, and cancellation.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSearchFetchQueue, parseListingHtml } = require("../search-fetcher.js");

test("search-fetcher request lifecycle & cancellation", async (t) => {
  await t.test("aborts active fetch requests on queue.dispose()", async () => {
    let wasAborted = false;

    const mockFetch = (url, options) => {
      return new Promise((resolve, reject) => {
        if (options?.signal) {
          options.signal.addEventListener("abort", () => {
            wasAborted = true;
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    };

    const queue = createSearchFetchQueue({
      fetchFn: mockFetch,
      maxConcurrent: 1,
      minDelayMs: 10,
    });

    queue.enqueue("prop_abort_test", "https://www.vrbo.com/abort_test");
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(queue.getActiveCount(), 1, "Request should be active");
    queue.dispose();

    await new Promise((r) => setTimeout(r, 30));
    assert.equal(wasAborted, true, "Active request signal should have aborted");
    assert.equal(queue.getActiveCount(), 0, "Active count should be 0 after dispose");
  });

  await t.test("timeout emits exactly one terminal status: timeout notification, frees slot, never retries, and never writes to storage", async () => {
    let wasAborted = false;
    let fetchAttempts = 0;
    const notifications = [];
    const storageWrites = [];

    const mockStorage = {
      get(keys, cb) { cb({}); },
      set(obj, cb) { storageWrites.push(obj); cb && cb(); },
      remove(keys, cb) { cb && cb(); },
    };

    const mockFetch = (url, options) => {
      fetchAttempts++;
      return new Promise((resolve, reject) => {
        if (options?.signal) {
          options.signal.addEventListener("abort", () => {
            wasAborted = true;
            const err = new Error("Timeout aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    };

    const queue = createSearchFetchQueue({
      fetchFn: mockFetch,
      storage: mockStorage,
      maxConcurrent: 1,
      minDelayMs: 10,
      requestTimeoutMs: 40, // 40ms timeout
    });

    queue.subscribe("prop_timeout", (res) => {
      notifications.push(res);
    });

    queue.enqueue("prop_timeout", "https://www.vrbo.com/timeout");
    await new Promise((r) => setTimeout(r, 120));

    assert.equal(wasAborted, true, "Stalled request should abort on timeout");
    assert.equal(queue.getActiveCount(), 0, "Slot should be freed after timeout");
    assert.equal(fetchAttempts, 1, "Timed out request must never automatically retry");
    assert.equal(notifications.length, 1, "Must emit exactly one notification");
    assert.deepEqual(notifications[0], { status: "timeout", propertyId: "prop_timeout" });
    assert.equal(storageWrites.length, 0, "Timeout must never write to persistent storage");
    queue.dispose();
  });

  await t.test("generic pet filter copy produces unknown, never ok", () => {
    const htmlWithGenericCopy = `
      <html>
        <body>
          <div class="search-widget">
            <input type="checkbox" name="pets">
            <label>I am traveling with pets If checked, only properties that allow pets will be shown</label>
          </div>
        </body>
      </html>
    `;
    const parsed = parseListingHtml(htmlWithGenericCopy, "prop_generic");
    assert.equal(parsed, null, "Generic search filter copy should produce null/no policy");
  });

  await t.test("valid property policy produces and caches ok", async () => {
    const storageWrites = [];
    const mockStorage = {
      get(keys, cb) { cb({}); },
      set(obj, cb) { storageWrites.push(obj); cb && cb(); },
      remove(keys, cb) { cb && cb(); },
    };

    const mockFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => "<section>House Rules: Pets welcome! Maximum of 2 dogs allowed, $50 fee.</section>",
    });

    const queue = createSearchFetchQueue({
      fetchFn: mockFetch,
      storage: mockStorage,
      maxConcurrent: 1,
      minDelayMs: 5,
    });

    const notifications = [];
    queue.subscribe("prop_valid", (res) => notifications.push(res));
    queue.enqueue("prop_valid", "https://www.vrbo.com/valid");

    await new Promise((r) => setTimeout(r, 40));

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].status, "ok");
    assert.equal(notifications[0].policy.petsAllowed, true);
    assert.equal(notifications[0].policy.maxDogs, 2);
    assert.equal(storageWrites.length, 1, "Valid policy must be cached to storage");
    queue.dispose();
  });
});
