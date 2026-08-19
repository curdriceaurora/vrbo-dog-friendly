// e2e/guardrail.js
// 8.2.4 / Issue #19: Live-traffic network guardrail and request auditing helper.

const { expect } = require("@playwright/test");

/**
 * Installs a catch-all backstop route and request audit on a Playwright context.
 *
 * @param {import("@playwright/test").BrowserContext} context
 * @param {import("@playwright/test").Page} [page]
 * @returns {Promise<{ assertNoLeakedRequests: () => void, getLeakedRequests: () => string[] }>}
 */
async function installNetworkGuard(context, page) {
  const leakedRequests = [];

  // Register the catch-all abort route FIRST on the context level.
  // In Playwright, subsequently registered routes on page/context take precedence.
  // Any unhandled vrbo.com request falls through to this catch-all backstop.
  await context.route("https://www.vrbo.com/**", (route) => {
    const url = route.request().url();
    leakedRequests.push(url);
    return route.abort("blockedbyclient");
  });

  // Track any page-level request events if page is provided
  if (page) {
    page.on("requestfailed", (request) => {
      const url = request.url();
      if (url.startsWith("https://www.vrbo.com/") && !leakedRequests.includes(url)) {
        const failure = request.failure();
        if (failure?.errorText?.includes("blockedbyclient") || failure?.errorText?.includes("ERR_BLOCKED_BY_CLIENT")) {
          leakedRequests.push(url);
        }
      }
    });
  }

  function getLeakedRequests() {
    return [...leakedRequests];
  }

  function assertNoLeakedRequests() {
    expect(
      leakedRequests,
      `Live traffic guardrail violation: unrouted vrbo.com requests detected:\n${leakedRequests.join("\n")}`
    ).toEqual([]);
  }

  return {
    assertNoLeakedRequests,
    getLeakedRequests,
  };
}

module.exports = {
  installNetworkGuard,
};
