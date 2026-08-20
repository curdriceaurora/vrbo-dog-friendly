const path = require("node:path");
const { chromium, expect, test } = require("@playwright/test");
const { installNetworkGuard } = require("./guardrail.js");

const EXTENSION_ROOT = path.join(__dirname, "..", "src");
const LISTING_URL = "https://www.vrbo.com/5442123";

const LISTING_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Listing 5442123</title>
    <style>
      body { margin: 0; padding: 0; }
      .container {
        display: flex;
        justify-content: center;
        width: 100vw;
      }
      [data-stid="lodging-infosite-template-api-renderer"] {
        width: 1200px;
        height: 2000px;
        background: #f0f0f0;
        position: relative;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div data-stid="lodging-infosite-template-api-renderer">
        <h2>House Rules</h2>
        <p>Dogs allowed! Max 2 dogs up to 50 lbs. $75 fee per stay.</p>
      </div>
    </div>
  </body>
</html>`;

test.describe("Issue #44: listing panel responsive positioning", () => {
  test("wide viewport (1920x1080): positions panel beside renderer with 340px width and expanded state", async () => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      headless: true,
      viewport: { width: 1920, height: 1080 },
      args: [
        `--disable-extensions-except=${EXTENSION_ROOT}`,
        `--load-extension=${EXTENSION_ROOT}`
      ]
    });

    try {
      const page = await context.newPage();
      const guard = await installNetworkGuard(context, page);

      await page.route("https://www.vrbo.com/5442123*", (route) => route.fulfill({
        status: 200,
        contentType: "text/html",
        body: LISTING_HTML
      }));

      await page.goto(LISTING_URL);

      const panel = page.locator("#vdp-panel");
      await expect(panel).toBeVisible({ timeout: 6000 });

      await expect(panel).toHaveClass(/vdp-beside/);
      await expect(panel).not.toHaveClass(/vdp-collapsed/);

      const panelBox = await panel.boundingBox();
      const renderer = page.locator('[data-stid="lodging-infosite-template-api-renderer"]');
      const rendererBox = await renderer.boundingBox();

      expect(panelBox).not.toBeNull();
      expect(rendererBox).not.toBeNull();

      // Panel left must start after renderer right (0px horizontal overlap)
      expect(panelBox.x).toBeGreaterThanOrEqual(rendererBox.x + rendererBox.width);
      expect(panelBox.width).toBeLessThanOrEqual(340);

      await guard.assertNoLeakedRequests(page);
    } finally {
      await context.close();
    }
  });

  test("constrained viewport (1440x900): starts collapsed at right:16px and expands on click/keyboard", async () => {
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

      await page.route("https://www.vrbo.com/5442123*", (route) => route.fulfill({
        status: 200,
        contentType: "text/html",
        body: LISTING_HTML
      }));

      await page.goto(LISTING_URL);

      const panel = page.locator("#vdp-panel");
      await expect(panel).toBeVisible({ timeout: 6000 });

      await expect(panel).not.toHaveClass(/vdp-beside/);
      await expect(panel).toHaveClass(/vdp-collapsed/);

      const header = panel.locator(".vdp-header");
      await expect(header).toHaveAttribute("aria-expanded", "false");

      // Click header to expand
      await header.click();
      await expect(panel).not.toHaveClass(/vdp-collapsed/);
      await expect(header).toHaveAttribute("aria-expanded", "true");

      const expandedBox = await panel.boundingBox();
      expect(expandedBox.width).toBe(400);

      // Keyboard toggle with Enter
      await header.focus();
      await page.keyboard.press("Enter");
      await expect(panel).toHaveClass(/vdp-collapsed/);
      await expect(header).toHaveAttribute("aria-expanded", "false");

      await guard.assertNoLeakedRequests(page);
    } finally {
      await context.close();
    }
  });

  test("dynamic window resize transitions between beside and constrained modes", async () => {
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

      await page.route("https://www.vrbo.com/5442123*", (route) => route.fulfill({
        status: 200,
        contentType: "text/html",
        body: LISTING_HTML
      }));

      await page.goto(LISTING_URL);

      const panel = page.locator("#vdp-panel");
      await expect(panel).toBeVisible({ timeout: 6000 });
      await expect(panel).not.toHaveClass(/vdp-beside/);

      // Resize to wide (1920x1080)
      await page.setViewportSize({ width: 1920, height: 1080 });
      await expect(panel).toHaveClass(/vdp-beside/);

      // Resize back to 1440
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(panel).not.toHaveClass(/vdp-beside/);

      await guard.assertNoLeakedRequests(page);
    } finally {
      await context.close();
    }
  });
});
