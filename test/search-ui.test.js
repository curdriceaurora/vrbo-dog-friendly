// test/search-ui.test.js
// Unit tests for search-fetcher AbortController, request timeouts, and cancellation.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSearchFetchQueue } = require("../search-fetcher.js");

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

  await t.test("aborts stalled fetch requests on requestTimeoutMs", async () => {
    let wasAborted = false;

    const mockFetch = (url, options) => {
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
      maxConcurrent: 1,
      minDelayMs: 10,
      requestTimeoutMs: 50, // 50ms timeout
    });

    queue.enqueue("prop_timeout", "https://www.vrbo.com/timeout");
    await new Promise((r) => setTimeout(r, 120));

    assert.equal(wasAborted, true, "Stalled request should abort on timeout");
    assert.equal(queue.getActiveCount(), 0, "Slot should be freed after timeout");
    queue.dispose();
  });
});
