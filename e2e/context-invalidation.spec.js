const { test, expect, chromium } = require("@playwright/test");
const path = require("path");
const fs = require("fs");
const { installNetworkGuard } = require("./guardrail");

const EXTENSION_ROOT = path.resolve(__dirname, "../src");

// chrome://extensions is a Polymer app; the extension's generated id is
// exposed as a plain attribute on its <extensions-item> custom element, so
// no shadow-DOM piercing is needed to read it. Mirrors the same helper in
// e2e/extension-theme.spec.js.
async function extensionIdFromManagementPage(context) {
  const page = await context.newPage();
  await page.goto("chrome://extensions/");
  const item = page.locator("extensions-item").filter({ hasText: "Vrbow" });
  await expect(item).toHaveCount(1);
  const extensionId = await item.getAttribute("id");
  await page.close();
  return extensionId;
}

const LISTING_HTML = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { margin: 0; padding: 0; }
    [data-stid="lodging-infosite-template-api-renderer"] {
      width: 1200px;
      height: 2000px;
      position: relative;
    }
  </style>
</head>
<body>
  <main>
    <div data-stid="lodging-infosite-template-api-renderer">
      <div>Dog friendly policy text scan fallback test. Pets allowed with prior approval.</div>
    </div>
  </main>
</body>
</html>
`;

test.describe("Extension Context Invalidation Handling", () => {
  test("gracefully cleans up and stops polling when context is invalidated", async () => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      headless: true,
      viewport: { width: 1440, height: 900 },
      args: [
        `--disable-extensions-except=${EXTENSION_ROOT}`,
        `--load-extension=${EXTENSION_ROOT}`
      ]
    });

    try {
      const page = await context.newPage();
      const guard = await installNetworkGuard(context, page);

      const pageErrors = [];
      page.on("pageerror", (err) => pageErrors.push(err));

      // Route listing page
      await page.route("https://www.vrbo.com/5442123*", (route) => route.fulfill({
        status: 200,
        contentType: "text/html",
        body: LISTING_HTML
      }));

      await page.goto("https://www.vrbo.com/5442123");

      const panel = page.locator("#vdp-panel");
      await expect(panel).toBeVisible({ timeout: 6000 });

      // Simulate extension context invalidation via a genuine extension-only
      // channel: chrome.tabs.sendMessage from the popup page. Ordinary page
      // JS has no access to chrome.tabs at all, so — unlike a window-
      // dispatched CustomEvent — this can't be triggered by the host page.
      const extensionId = await extensionIdFromManagementPage(context);
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
      await popup.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ url: "*://*.vrbo.com/*" });
        await chrome.tabs.sendMessage(tab.id, { type: "vdp-test-trigger-invalidation" });
      });
      await popup.close();

      // Verify the panel is removed from the DOM
      await expect(panel).not.toBeVisible({ timeout: 4000 });

      // Verify cleanup actually stopped the polling interval rather than
      // just removing the panel once: re-firing a location change after
      // cleanup must not resurrect it or throw.
      await page.evaluate(() => {
        window.dispatchEvent(new Event("vdp-locationchange"));
      });
      await page.waitForTimeout(1200);
      await expect(panel).not.toBeVisible();

      // Verify no uncaught exceptions were thrown in the page throughout.
      expect(pageErrors).toEqual([]);

      await guard.assertNoLeakedRequests(page);
    } finally {
      await context.close();
    }
  });
});
