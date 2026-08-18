const path = require("node:path");
const { chromium, expect, test } = require("@playwright/test");

const EXTENSION_ROOT = path.join(__dirname, "..");
const SEARCH_URL = "https://www.vrbo.com/Hotel-Search?destination=Seattle&house_rules_group=pets_allowed";

// Realistic Vrbo search card structure with card-wide anchor overlay (.uitk-card-link)
const SEARCH_HTML_WITH_OVERLAY = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Hit-Testing Search Test</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; padding: 20px; font-family: sans-serif; }
      .Results { display: flex; flex-direction: column; gap: 16px; }
      [data-stid="property-card"] {
        position: relative;
        width: 380px;
        height: 260px;
        border: 1px solid #ccc;
        border-radius: 8px;
        overflow: hidden;
      }
      /* Host page card-wide transparent anchor overlay covering the entire card */
      .uitk-card-link {
        position: absolute;
        inset: 0;
        z-index: 1;
        background: transparent;
        display: block;
      }
      .uitk-card-content {
        position: relative;
        padding: 16px;
        z-index: 0;
      }
    </style>
  </head>
  <body>
    <main id="search-main">
      <div class="Results">
        <div data-stid="property-card" id="card-1">
          <!-- Card-wide click overlay -->
          <a class="uitk-card-link" data-stid="open-product-information" href="https://www.vrbo.com/5551234?chkin=2026-09-01&adults=2"></a>
          <div class="uitk-card-content">
            <h3>Emerald City Retreat</h3>
            <p>$185 / night</p>
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

test("verifies browser hit-testing order, physical mouse coordinate hover, and click interception over card overlay", async () => {
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
    const navigatedUrls = [];
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigatedUrls.push(frame.url());
    });

    await page.route("https://www.vrbo.com/Hotel-Search*", (route) => route.fulfill({
      status: 200,
      contentType: "text/html",
      body: SEARCH_HTML_WITH_OVERLAY
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

    const box = await badge.boundingBox();
    expect(box).not.toBeNull();
    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;

    // 1. Assertive Browser Hit-Testing Validation
    // The element at the badge center coordinate MUST be the badge or its child, NOT .uitk-card-link
    const hitTarget = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      const stack = document.elementsFromPoint(x, y).map(e => `${e.tagName}.${e.className}`);
      return {
        tag: el?.tagName,
        className: el?.className,
        insideBadge: !!el?.closest(".vdp-search-badge"),
        stack
      };
    }, { x: centerX, y: centerY });

    expect(hitTarget.insideBadge).toBe(true);

    // 2. Physical-Style Mouse Coordinate Hover (page.mouse.move)
    // Move from outside directly to the exact badge coordinate using physical mouse pipeline
    await page.mouse.move(0, 0);
    const tooltip = page.locator("#vdp-search-tooltip");
    await expect(tooltip).not.toBeVisible();

    await page.mouse.move(centerX, centerY);
    await expect(tooltip).toBeVisible({ timeout: 4_000 });
    await expect(tooltip).toHaveAttribute("aria-hidden", "false");
    await expect(badge).toHaveAttribute("aria-expanded", "true");

    // 3. Move mouse away -> tooltip hides
    await page.mouse.move(0, 0);
    await expect(tooltip).not.toBeVisible({ timeout: 4_000 });
    await expect(tooltip).toHaveAttribute("aria-hidden", "true");

    // 4. Physical Mouse Click Interception
    // Clicking the badge directly via mouse coordinates MUST open the tooltip and NOT navigate to the listing URL
    const navCountBefore = navigatedUrls.length;
    await page.mouse.click(centerX, centerY);
    await expect(tooltip).toBeVisible({ timeout: 4_000 });

    // Ensure we stayed on the search page and did not navigate away
    expect(navigatedUrls.length).toBe(navCountBefore);
    expect(page.url()).toContain("Hotel-Search");

    expect(pageErrors).toEqual([]);
  } finally {
    await context.close();
  }
});
