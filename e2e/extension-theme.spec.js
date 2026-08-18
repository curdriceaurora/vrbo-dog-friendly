const path = require("node:path");
const { chromium, expect, test } = require("@playwright/test");

const EXTENSION_ROOT = path.join(__dirname, "..");
const LISTING_URL = "https://www.vrbo.com/123456";

const LISTING_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Theme test listing</title></head>
  <body>
    <main>
      <section aria-label="House Rules">
        <h2>House Rules</h2>
        <p>Two dogs up to 50 lbs are welcome. A $150 pet fee applies per stay. Prior approval is required.</p>
      </section>
    </main>
  </body>
</html>`;

const EXPECTED = {
  light: {
    surface: "rgb(255, 255, 255)",
    text: "rgb(32, 33, 36)",
    allowed: "rgb(19, 115, 51)",
    focus: "rgb(0, 95, 204)"
  },
  dark: {
    surface: "rgb(32, 33, 36)",
    text: "rgb(241, 243, 244)",
    allowed: "rgb(129, 201, 149)",
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
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.route(LISTING_URL, (route) => route.fulfill({
        status: 200,
        contentType: "text/html",
        body: LISTING_HTML
      }));
      await page.goto(LISTING_URL);

      const panel = page.locator("#vdp-panel");
      await expect(panel).toBeVisible({ timeout: 8_000 });
      await expect(panel).toContainText("Dog policy found");
      await expect(panel).toContainText("Max dogs");
      await expect(panel).toContainText("50 lbs");
      await expect(panel).toContainText("$150");
      await expect(panel).toHaveCSS("background-color", EXPECTED[scheme].surface);
      await expect(panel).toHaveCSS("color", EXPECTED[scheme].text);
      await expect(panel.locator(".vdp-tone-good").first()).toHaveCSS("color", EXPECTED[scheme].allowed);
      expect(pageErrors).toEqual([]);

      const extensionId = await extensionIdFromManagementPage(context);
      expect(extensionId).toMatch(/^[a-p]{32}$/);

      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
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
