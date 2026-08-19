// e2e/guardrail.js
// 8.2.4 / Issue #19: Live-traffic network guardrail and request auditing helper.

const { expect } = require("@playwright/test");

/**
 * Installs a catch-all backstop route and request audit on a Playwright context.
 * Intercepts and aborts any outbound HTTP/HTTPS network traffic not explicitly routed.
 *
 * @param {import("@playwright/test").BrowserContext} context
 * @param {import("@playwright/test").Page} [defaultPage]
 * @returns {Promise<{
 *   assertNoLeakedRequests: (page?: import("@playwright/test").Page, options?: { settleMs?: number }) => Promise<void>,
 *   getLeakedRequests: () => string[],
 *   attachPage: (page: import("@playwright/test").Page) => void
 * }>}
 */
async function installNetworkGuard(context, defaultPage) {
  const leakedRequests = new Set();

  function isInternalUrl(url) {
    return (
      url.startsWith("file:") ||
      url.startsWith("data:") ||
      url.startsWith("about:") ||
      url.startsWith("chrome-extension:") ||
      url.startsWith("chrome:")
    );
  }

  // Register the catch-all abort route FIRST on the context level.
  // In Playwright, subsequently registered routes on page/context take precedence.
  // Any unhandled external network request falls through to this catch-all backstop.
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (isInternalUrl(url)) {
      return route.continue();
    }
    leakedRequests.add(url);
    return route.abort("blockedbyclient");
  });

  function attachPage(page) {
    if (!page) return;
    page.on("requestfailed", (request) => {
      const url = request.url();
      if (!isInternalUrl(url)) {
        const failure = request.failure();
        if (failure?.errorText?.includes("blockedbyclient") || failure?.errorText?.includes("ERR_BLOCKED_BY_CLIENT")) {
          leakedRequests.add(url);
        }
      }
    });
  }

  // Auto-attach any pages created in this context
  if (typeof context.on === "function") {
    context.on("page", (p) => attachPage(p));
  }

  if (defaultPage) {
    attachPage(defaultPage);
  }

  function getLeakedRequests() {
    return Array.from(leakedRequests);
  }

  async function assertNoLeakedRequests(targetPage = defaultPage, { settleMs = 800 } = {}) {
    if (settleMs > 0) {
      const activePage = targetPage || (typeof context.pages === "function" ? context.pages()[0] : null);
      if (activePage && !activePage.isClosed?.()) {
        try {
          await activePage.waitForTimeout(settleMs);
        } catch {
          await new Promise((r) => setTimeout(r, settleMs));
        }
      } else {
        await new Promise((r) => setTimeout(r, settleMs));
      }
    }

    const leakedList = Array.from(leakedRequests);
    expect(
      leakedList,
      `Live traffic guardrail violation: unrouted outbound requests detected:\n${leakedList.join("\n")}`
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
