const path = require("node:path");
const { chromium, expect, test } = require("@playwright/test");

const EXTENSION_ROOT = path.join(__dirname, "..");
const SEARCH_URL = "https://www.vrbo.com/Hotel-Search?destination=Seattle&house_rules_group=pets_allowed";

const SEARCH_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Accessibility Contract Search</title></head>
  <body>
    <main id="search-main">
      <input type="text" id="external-input" placeholder="Search destination" />
      <div class="Results">
        <div data-stid="property-card" id="card-1">
          <div class="uitk-card-content">
            <a href="https://www.vrbo.com/5551234?chkin=2026-09-01&adults=2">Emerald City Retreat</a>
          </div>
        </div>
      </div>
    </main>
  </body>
</html>`;

const LISTING_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Emerald City Retreat</title></head>
  <body>
    <main>
      <section aria-label="House Rules">
        <h2>House Rules</h2>
        <p>Dogs welcome! Maximum 2 dogs allowed up to 50 lbs. $75 pet fee.</p>
      </section>
    </main>
  </body>
</html>`;

test("8.1.6: verifies dialog accessibility contract, non-modal semantics, focus-only opening, and keyboard loop", async () => {
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
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

    await page.route("https://www.vrbo.com/Hotel-Search*", (route) => route.fulfill({
      status: 200,
      contentType: "text/html",
      body: SEARCH_HTML
    }));

    await page.route("https://www.vrbo.com/5551234*", (route) => route.fulfill({
      status: 200,
      contentType: "text/html",
      body: LISTING_HTML
    }));

    await page.goto(SEARCH_URL);

    const badge = page.locator(".vdp-search-badge").first();
    await expect(badge).toBeVisible({ timeout: 6_000 });
    await expect(badge).toHaveClass(/vdp-badge-allowed/);

    const tooltip = page.locator("#vdp-search-tooltip");
    await expect(tooltip).toHaveCount(1);

    // 1. Accessibility Structure & Non-Modal Contract
    await expect(tooltip).toHaveAttribute("role", "dialog");
    await expect(tooltip).toHaveAttribute("aria-label", "Dog policy");
    await expect(tooltip).toHaveAttribute("aria-hidden", "true");
    await expect(tooltip).not.toHaveAttribute("aria-modal", "true");

    await expect(badge).toHaveAttribute("role", "button");
    await expect(badge).toHaveAttribute("tabindex", "0");
    await expect(badge).toHaveAttribute("aria-haspopup", "dialog");
    await expect(badge).toHaveAttribute("aria-controls", "vdp-search-tooltip");
    await expect(badge).toHaveAttribute("aria-expanded", "false");

    // 2. Mouse Hover Opening does NOT steal focus
    const externalInput = page.locator("#external-input");
    await externalInput.focus();
    await expect(externalInput).toBeFocused();

    // Hover over badge
    await badge.hover();
    await expect(tooltip).toBeVisible({ timeout: 4_000 });
    await expect(tooltip).toHaveAttribute("aria-hidden", "false");
    await expect(badge).toHaveAttribute("aria-expanded", "true");
    // Assert focus remains on external input
    await expect(externalInput).toBeFocused();

    // Unhover to hide
    await page.mouse.move(0, 0);
    await expect(tooltip).not.toBeVisible({ timeout: 4_000 });
    await expect(tooltip).toHaveAttribute("aria-hidden", "true");
    await expect(badge).toHaveAttribute("aria-expanded", "false");

    // 3. Focus-only Opening (without Enter): focus remains on badge
    await badge.focus();
    await expect(badge).toBeFocused();
    await expect(tooltip).toBeVisible({ timeout: 4_000 });
    await expect(tooltip).toHaveAttribute("aria-hidden", "false");
    await expect(badge).toHaveAttribute("aria-expanded", "true");
    // Crucial: focus must STAY on badge, not jump to Close button
    await expect(badge).toBeFocused();

    // 4. Keyboard Activation via Enter: moves focus to Close button
    await page.keyboard.press("Enter");
    const closeBtn = tooltip.locator(".vdp-tooltip-close");
    const listingLink = tooltip.locator(".vdp-tooltip-footer a");
    await expect(closeBtn).toBeFocused({ timeout: 4_000 });

    // 5. Focus Looping (Tab / Shift+Tab inside dialog)
    // Tab from Close -> Listing Link
    await page.keyboard.press("Tab");
    await expect(listingLink).toBeFocused();

    // Tab from Listing Link wraps -> Close button
    await page.keyboard.press("Tab");
    await expect(closeBtn).toBeFocused();

    // Shift+Tab from Close button wraps -> Listing Link
    await page.keyboard.press("Shift+Tab");
    await expect(listingLink).toBeFocused();

    // Shift+Tab from Listing Link -> Close button
    await page.keyboard.press("Shift+Tab");
    await expect(closeBtn).toBeFocused();

    // 6. Escape inside dialog: dismisses tooltip and restores focus to badge
    await page.keyboard.press("Escape");
    await expect(tooltip).not.toBeVisible({ timeout: 4_000 });
    await expect(tooltip).toHaveAttribute("aria-hidden", "true");
    await expect(badge).toHaveAttribute("aria-expanded", "false");
    await expect(badge).toBeFocused();

    // 7. Space activation + Close button click restoration
    await page.keyboard.press("Space");
    await expect(tooltip).toBeVisible();
    await expect(closeBtn).toBeFocused();

    await closeBtn.click();
    await expect(tooltip).not.toBeVisible();
    await expect(tooltip).toHaveAttribute("aria-hidden", "true");
    await expect(badge).toHaveAttribute("aria-expanded", "false");
    await expect(badge).toBeFocused();

    // 8. Assert zero page errors
    expect(pageErrors).toEqual([]);
  } finally {
    await context.close();
  }
});
