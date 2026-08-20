const { test, expect, chromium } = require("@playwright/test");
const path = require("path");
const fs = require("fs");
const { installNetworkGuard } = require("./guardrail");

const EXTENSION_ROOT = path.resolve(__dirname, "../src");

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

      // Route listing page
      await page.route("https://www.vrbo.com/5442123*", (route) => route.fulfill({
        status: 200,
        contentType: "text/html",
        body: LISTING_HTML
      }));

      await page.goto("https://www.vrbo.com/5442123");

      const panel = page.locator("#vdp-panel");
      await expect(panel).toBeVisible({ timeout: 6000 });

      // Simulate extension context invalidation
      await page.evaluate(() => {
        window.dispatchEvent(new Event("vdp-test-trigger-invalidation"));
      });

      // Trigger locationcheck / url check to fire onUrlMaybeChanged
      await page.evaluate(() => {
        window.dispatchEvent(new Event("vdp-locationchange"));
      });

      // Verify the panel is removed from the DOM
      await expect(panel).not.toBeVisible({ timeout: 4000 });

      // Verify no uncaught exceptions are thrown in the page afterwards
      await guard.assertNoLeakedRequests(page);
    } finally {
      await context.close();
    }
  });
});
