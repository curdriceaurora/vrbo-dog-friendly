// e2e/guardrail.js
// 8.2.4 / Issue #19: Live-traffic network guardrail and request auditing helper.

const { expect } = require("@playwright/test");

/**
 * Installs a catch-all backstop route and request audit on a Playwright context.
 *
 * @param {import("@playwright/test").BrowserContext} context
 * @param {import("@playwright/test").Page} [defaultPage]
 * @returns {Promise<{ assertNoLeakedRequests: (page?: import("@playwright/test").Page, options?: { settleMs?: number }) => Promise<void>, getLeakedRequests: () => string[] }>}
 */
async function installNetworkGuard(context, defaultPage) {
  const leakedRequests = new Set();

  // Register the catch-all abort route FIRST on the context level.
  // In Playwright, subsequently registered routes on page/context take precedence.
  // Any unhandled vrbo.com request falls through to this catch-all backstop.
  await context.route("https://www.vrbo.com/**", (route) => {
    const url = route.request().url();
    leakedRequests.add(url);
    return route.abort("blockedbyclient");
  });

  function attachPage(page) {
    if (!page) return;
    page.on("requestfailed", (request) => {
      const url = request.url();
      if (url.startsWith("https://www.vrbo.com/")) {
        const failure = request.failure();
        if (failure?.errorText?.includes("blockedbyclient") || failure?.errorText?.includes("ERR_BLOCKED_BY_CLIENT")) {
          leakedRequests.add(url);
        }
      }
    });
  }

  if (defaultPage) {
    attachPage(defaultPage);
  }

  function getLeakedRequests() {
    return Array.from(leakedRequests);
  }

  async function assertNoLeakedRequests(page = defaultPage, { settleMs = 800 } = {}) {
    if (page && settleMs > 0) {
      try {
        await page.waitForTimeout(settleMs);
      } catch {
        // Ignore if page/context was already closed
      }
    }
    const leakedList = Array.from(leakedRequests);
    expect(
      leakedList,
      `Live traffic guardrail violation: unrouted vrbo.com requests detected:\n${leakedList.join("\n")}`
    ).toEqual([]);
  }

  return {
    assertNoLeakedRequests,
    getLeakedRequests,
    attachPage,
  };
}

module.exports = {
  installNetworkGuard,
};
