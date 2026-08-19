const path = require("node:path");
const { chromium, expect, test } = require("@playwright/test");
const { installNetworkGuard } = require("./guardrail.js");

const EXTENSION_ROOT = path.join(__dirname, "..", "src");
const LISTING_URL = "https://www.vrbo.com/123456";
const SEARCH_URL = "https://www.vrbo.com/Hotel-Search?destination=Miami&house_rules_group=pets_allowed";

const LISTING_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Theme test listing</title></head>
  <body>
    <main>
      <section aria-label="House Rules">
        <h2>House Rules</h2>
        <p>Pets are allowed. Two dogs up to 50 lbs are welcome. A $150 pet fee applies per stay. Prior approval is required.</p>
      </section>
    </main>
  </body>
</html>`;

const SEARCH_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Theme test search</title></head>
  <body>
    <main>
      <div class="Results">
        <div data-stid="property-card">
          <a href="https://www.vrbo.com/123456">Sunny Beach House</a>
        </div>
      </div>
    </main>
  </body>
</html>`;

const EXPECTED = {
  light: {
    surface: "rgb(255, 255, 255)",
    text: "rgb(32, 33, 36)",
    allowed: "rgb(19, 115, 51)",
    allowedSurface: "rgb(230, 244, 234)",
    warning: "rgb(117, 75, 0)",
    warningSurface: "rgb(255, 244, 206)",
    focus: "rgb(0, 95, 204)"
  },
  dark: {
    surface: "rgb(32, 33, 36)",
    text: "rgb(241, 243, 244)",
    allowed: "rgb(129, 201, 149)",
    allowedSurface: "rgb(23, 60, 37)",
    warning: "rgb(253, 214, 99)",
    warningSurface: "rgb(74, 53, 16)",
    focus: "rgb(168, 199, 250)"
  }
};

async function extensionIdFromManagementPage(context) {
  const page = await context.newPage();
  await page.goto("chrome://extensions/");
  const item = page.locator("extensions-item").filter({ hasText: "Vrbow" });
  await expect(item).toHaveCount(1);
  const extensionId = await item.getAttribute("id");
  await page.close();
  return extensionId;
}

for (const scheme of ["light", "dark"]) {
  test(`${scheme} theme loads through the real extension manifest`, async () => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      colorScheme: scheme,
      headless: true,
      args: [
        `--disable-extensions-except=${EXTENSION_ROOT}`,
        `--load-extension=${EXTENSION_ROOT}`
      ]
    });

    try {
      const pageErrors = [];
      const page = await context.newPage();
      const guard = await installNetworkGuard(context, page);
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.route("https://www.vrbo.com/123456*", (route) => route.fulfill({
        status: 200,
        contentType: "text/html",
        body: LISTING_HTML
      }));
      await page.route("https://www.vrbo.com/Hotel-Search*", (route) => route.fulfill({
        status: 200,
        contentType: "text/html",
        body: SEARCH_HTML
      }));

      // Listing page verification
      await page.goto(LISTING_URL);

      const panel = page.locator("#vdp-panel");
      await expect(panel).toBeVisible({ timeout: 8_000 });
      await expect(panel).toContainText("Dog-friendly");
      await expect(panel).toContainText("Max dogs");
      await expect(panel).toContainText("50 lbs");
      await expect(panel).toContainText("$150");
      await expect(panel).toHaveCSS("background-color", EXPECTED[scheme].surface);
      await expect(panel).toHaveCSS("color", EXPECTED[scheme].text);
      await expect(panel.locator(".vdp-tone-good").first()).toHaveCSS("color", EXPECTED[scheme].allowed);

      // Search page verification & content-script discovery
      await page.goto(SEARCH_URL);
      const badge = page.locator(".vdp-search-badge").first();
      await expect(badge).toBeVisible({ timeout: 8_000 });
      await expect(badge).toHaveClass(/vdp-badge-allowed/);
      await expect(badge).toHaveCSS("color", EXPECTED[scheme].allowed);
      await expect(badge).toHaveCSS("background-color", EXPECTED[scheme].allowedSurface);

      const tooltip = page.locator(".vdp-search-tooltip");
      const tooltipClose = tooltip.locator(".vdp-tooltip-close");
      const tooltipLink = tooltip.locator(".vdp-tooltip-footer a");

      // Keyboard Flow: Open on Enter
      await badge.focus();
      await expect(badge).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(tooltip).toBeVisible();
      await expect(tooltip).toHaveCSS("background-color", EXPECTED[scheme].surface);
      await expect(tooltip).toHaveCSS("color", EXPECTED[scheme].text);

      // Keyboard Flow: Focus wrapping inside dialog
      await expect(tooltipClose).toBeFocused({ timeout: 4000 });
      await page.keyboard.press("Tab");
      await expect(tooltipLink).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(tooltipClose).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(tooltipLink).toBeFocused();

      // Keyboard Flow: Dismiss on Escape & Focus Restoration
      await page.keyboard.press("Escape");
      await expect(tooltip).not.toBeVisible();
      await expect(badge).toBeFocused();

      expect(pageErrors).toEqual([]);
      await guard.assertNoLeakedRequests(page);

      const extensionId = await extensionIdFromManagementPage(context);
      expect(extensionId).toMatch(/^[a-p]{32}$/);

      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
      await popup.bringToFront();
      await expect(popup.locator("html")).toHaveCSS("color-scheme", scheme);
      await expect(popup.locator("body")).toHaveCSS("background-color", EXPECTED[scheme].surface);
      await expect(popup.locator("body")).toHaveCSS("color", EXPECTED[scheme].text);
      const rescan = popup.locator("#rescan");
      await rescan.evaluate((button) => button.focus());
      await expect(rescan).toHaveCSS("outline-color", EXPECTED[scheme].focus);
    } finally {
      await context.close();
    }
  });
}
