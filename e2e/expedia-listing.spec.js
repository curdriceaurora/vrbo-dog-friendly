const path = require("node:path");
const { chromium, expect, test } = require("@playwright/test");
const { installNetworkGuard } = require("./guardrail.js");
const { NO_PETS_PAYLOAD, PET_FEE_PAYLOAD, pageHtml } = require("./expedia-payloads.js");

const EXTENSION_ROOT = path.join(__dirname, "..", "src");

async function launchExpediaExtensionContext() {
  return chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: [
      `--disable-extensions-except=${EXTENSION_ROOT}`,
      `--load-extension=${EXTENSION_ROOT}`,
    ],
  });
}

test.describe("Expedia adapter: real extension end-to-end (issue #11)", () => {
  test("pet-fee listing renders count, weight, and per-pet per-night fee", async () => {
    const context = await launchExpediaExtensionContext();
    try {
      const page = await context.newPage();
      const guard = await installNetworkGuard(context, page);
      await page.route(`${PET_FEE_PAYLOAD.url}*`, (route) =>
        route.fulfill({ status: 200, contentType: "text/html", body: pageHtml(PET_FEE_PAYLOAD) })
      );

      await page.goto(PET_FEE_PAYLOAD.url);
      const panel = page.locator("#vdp-panel");
      await expect(panel).toBeVisible({ timeout: 6000 });
      await expect(panel.locator(".vdp-title")).toHaveText("Dog policy");
      await expect(panel).toContainText("Max dogs");
      await expect(panel).toContainText("2");
      await expect(panel).toContainText("75 lbs");
      await expect(panel).toContainText("$25 per pet per night");

      await guard.assertNoLeakedRequests(page);
    } finally {
      await context.close();
    }
  });

  test("explicit no-pets listing renders prohibited state", async () => {
    const context = await launchExpediaExtensionContext();
    try {
      const page = await context.newPage();
      const guard = await installNetworkGuard(context, page);
      await page.route(`${NO_PETS_PAYLOAD.url}*`, (route) =>
        route.fulfill({ status: 200, contentType: "text/html", body: pageHtml(NO_PETS_PAYLOAD) })
      );

      await page.goto(NO_PETS_PAYLOAD.url);
      const panel = page.locator("#vdp-panel");
      await expect(panel).toBeVisible({ timeout: 6000 });
      await expect(panel).toContainText("No pets allowed");
      await expect(panel.locator(".vdp-header")).toHaveClass(/vdp-tone-bad/);

      await guard.assertNoLeakedRequests(page);
    } finally {
      await context.close();
    }
  });
});
