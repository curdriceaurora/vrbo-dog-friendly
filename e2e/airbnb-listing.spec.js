const path = require("node:path");
const { chromium, expect, test } = require("@playwright/test");
const { installNetworkGuard } = require("./guardrail.js");
const { TOGGLE_ONLY_PAYLOAD, BURIED_FEE_PAYLOAD } = require("./airbnb-payloads.js");

const EXTENSION_ROOT = path.join(__dirname, "..", "src");
const LISTING_URL = "https://www.airbnb.com/rooms/42406610";

// Minimal but structurally real payloads — same shape as the real captures
// in test/fixtures/airbnb/*.json (see test/site-adapters-airbnb.test.js for
// parsing correctness against those). This spec's job is different: prove
// the real extension, loaded via manifest.json, actually wires
// #data-deferred-state-0 -> the adapter -> content.js's scan() -> the
// rendered panel end to end — not re-verify extraction logic already
// covered by unit tests.
function pageHtml(niobeClientData) {
  const payload = JSON.stringify({ niobeClientData });
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Listing 42406610</title></head>
  <body>
    <script id="data-deferred-state-0" type="application/json">${payload}</script>
  </body>
</html>`;
}

async function launchAirbnbExtensionContext() {
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

test.describe("Airbnb adapter: real extension end-to-end (issue #12)", () => {
  test("toggle-only listing renders the 'Allowed, no additional restrictions listed' state, not the generic unconfirmed one", async () => {
    const context = await launchAirbnbExtensionContext();

    try {
      const page = await context.newPage();
      const guard = await installNetworkGuard(context, page);

      await page.route(`${LISTING_URL}*`, (route) =>
        route.fulfill({ status: 200, contentType: "text/html", body: pageHtml(TOGGLE_ONLY_PAYLOAD) })
      );

      await page.goto(LISTING_URL);

      const panel = page.locator("#vdp-panel");
      await expect(panel).toBeVisible({ timeout: 6000 });
      await expect(panel.locator(".vdp-title")).toHaveText("Dog policy");
      await expect(panel.locator(".vdp-header")).toHaveClass(/vdp-tone-good/);

      const sparseText = panel.locator(".vdp-unconfirmed-text");
      await expect(sparseText).toHaveText(/Allowed, no additional restrictions listed/);
      await expect(sparseText).toHaveClass(/vdp-tone-good/);

      // The generic "weren't stated" wording, unqualified by "Allowed",
      // must not also be present — this is the distinct branch, not a
      // superset of the existing unconfirmed one.
      await expect(panel).not.toContainText(/^Max dogs, weight limit/);

      // The WHAT_COUNTS_AS_A_PET boilerplate must not leak into the panel.
      await expect(panel).not.toContainText(/Service animals aren.t pets/);

      await guard.assertNoLeakedRequests(page);
    } finally {
      await context.close();
    }
  });

  test("buried-fee listing renders real Max dogs / Fee rows, not the sparse state", async () => {
    const context = await launchAirbnbExtensionContext();

    try {
      const page = await context.newPage();
      const guard = await installNetworkGuard(context, page);

      await page.route(`${LISTING_URL}*`, (route) =>
        route.fulfill({ status: 200, contentType: "text/html", body: pageHtml(BURIED_FEE_PAYLOAD) })
      );

      await page.goto(LISTING_URL);

      const panel = page.locator("#vdp-panel");
      await expect(panel).toBeVisible({ timeout: 6000 });
      await expect(panel).not.toContainText(/Allowed, no additional restrictions listed/);
      await expect(panel).toContainText(/Fee/);
      await expect(panel).toContainText(/\$40/);

      await guard.assertNoLeakedRequests(page);
    } finally {
      await context.close();
    }
  });
});
