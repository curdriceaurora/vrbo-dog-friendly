const path = require("node:path");
const { chromium, expect, test } = require("@playwright/test");
const { installNetworkGuard } = require("./guardrail.js");

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
    const guard = await installNetworkGuard(context, page);
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
    await guard.assertNoLeakedRequests(page);
  } finally {
    await context.close();
  }
});

test("verifies live-traffic guardrail aborts unrouted requests and catches violations", async () => {
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${EXTENSION_ROOT}`,
      `--load-extension=${EXTENSION_ROOT}`
    ]
  });

  try {
    const page = await context.newPage();
    const guard = await installNetworkGuard(context, page);

    // Provide search page with an intentionally unrouted property link
    await page.route("https://www.vrbo.com/Hotel-Search*", (route) => route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html>
<html>
  <body>
    <main>
      <div class="Results">
        <div data-stid="property-card" id="card-unrouted">
          <a href="https://www.vrbo.com/9999999?chkin=2026-09-01">Unrouted Listing</a>
        </div>
      </div>
    </main>
  </body>
</html>`
    }));

    await page.goto(SEARCH_URL);
    const card = page.locator("#card-unrouted");
    await expect(card.locator(".vdp-search-badge")).toBeVisible({ timeout: 6_000 });

    // Wait past dwell and dispatch to ensure fetch attempt is caught by catch-all
    await page.waitForTimeout(1_500);

    const leaked = guard.getLeakedRequests();
    expect(leaked.some((url) => url.includes("9999999"))).toBe(true);
    await expect(guard.assertNoLeakedRequests(page, { settleMs: 0 })).rejects.toThrow(/Live traffic guardrail violation/);
  } finally {
    await context.close();
  }
});

// #18: the layout that reproduces the mount bug — a price element AHEAD of the
// content column in document order, inside a flex-row content container.
//
// Deliberately NO global `* { box-sizing: border-box }`. Vrbo does not guarantee
// one and the extension stylesheet does not set one, so a fixture that declares
// it would hide the 18px overflow that `box-sizing` on .vdp-search-badge exists
// to prevent.
const SEARCH_HTML_PRICE_FIRST = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Badge Width Test</title>
    <style>
      body { margin: 0; padding: 20px; font-family: sans-serif; }
      .Results { display: flex; flex-direction: column; gap: 16px; }
      [data-stid="property-card"] {
        position: relative;
        width: 380px;
        border: 1px solid #ccc;
        border-radius: 8px;
      }
      .uitk-card-link { position: absolute; inset: 0; z-index: 1; background: transparent; display: block; }
      /* Flex-row content column: width:100% on the badge alone would overflow here. */
      .uitk-card-content { position: relative; display: flex; flex-direction: row; flex-wrap: wrap; padding: 16px; z-index: 0; }
      [data-stid="price-summary"] { width: 60px; padding: 2px; }
    </style>
  </head>
  <body>
    <main id="search-main">
      <div class="Results">
        <div data-stid="property-card" id="card-short">
          <a class="uitk-card-link" data-stid="open-product-information" href="https://www.vrbo.com/7000001?chkin=2026-09-01"></a>
          <div data-stid="price-summary">$185</div>
          <div class="uitk-card-content"><h3>Short Label Cabin</h3></div>
        </div>
        <div data-stid="property-card" id="card-long">
          <a class="uitk-card-link" data-stid="open-product-information" href="https://www.vrbo.com/7000002?chkin=2026-09-01"></a>
          <div data-stid="price-summary">$240</div>
          <div class="uitk-card-content"><h3>Long Label Lodge</h3></div>
        </div>
      </div>
    </main>
  </body>
</html>`;

const LISTING_SHORT = `<!doctype html><html><body><main><section aria-label="House Rules">
  <h2>House Rules</h2><p>Dogs welcome!</p></section></main></body></html>`;

const LISTING_LONG = `<!doctype html><html><body><main><section aria-label="House Rules">
  <h2>House Rules</h2><p>Dogs welcome! Maximum 2 dogs allowed up to 50 lbs. $150 per night pet fee. $200 deposit required.</p>
  </section></main></body></html>`;

test("#18: badge spans the content column identically regardless of label, and wins hit-testing across its full width", async () => {
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${EXTENSION_ROOT}`,
      `--load-extension=${EXTENSION_ROOT}`
    ]
  });

  try {
    const page = await context.newPage();
    const guard = await installNetworkGuard(context, page);

    await page.route("https://www.vrbo.com/Hotel-Search*", (route) => route.fulfill({
      status: 200, contentType: "text/html", body: SEARCH_HTML_PRICE_FIRST
    }));
    await page.route("https://www.vrbo.com/7000001*", (route) => route.fulfill({
      status: 200, contentType: "text/html", body: LISTING_SHORT
    }));
    await page.route("https://www.vrbo.com/7000002*", (route) => route.fulfill({
      status: 200, contentType: "text/html", body: LISTING_LONG
    }));

    await page.goto(SEARCH_URL);

    const shortBadge = page.locator("#card-short .vdp-search-badge");
    const longBadge = page.locator("#card-long .vdp-search-badge");
    await expect(shortBadge).toBeVisible({ timeout: 8_000 });
    await expect(longBadge).toBeVisible({ timeout: 8_000 });

    // Root cause: the badge must land in the content column, not the price box
    // that precedes it in document order.
    for (const id of ["card-short", "card-long"]) {
      const mountedIn = await page.evaluate((cardId) => {
        const badge = document.querySelector(`#${cardId} .vdp-search-badge`);
        return {
          slot: badge.parentElement.className,
          host: badge.parentElement.parentElement.className,
        };
      }, id);
      expect(mountedIn.slot).toContain("vdp-badge-slot");
      expect(mountedIn.host).toContain("uitk-card-content");
    }

    // Wait for both labels to resolve so widths are measured on final text.
    await expect(shortBadge).not.toHaveText(/Checking pet policy/, { timeout: 8_000 });
    await expect(longBadge).not.toHaveText(/Checking pet policy/, { timeout: 8_000 });

    const metrics = await page.evaluate(() => {
      const read = (cardId) => {
        const badge = document.querySelector(`#${cardId} .vdp-search-badge`);
        const host = badge.parentElement.parentElement;
        const hostStyle = getComputedStyle(host);
        const inner = host.clientWidth
          - parseFloat(hostStyle.paddingLeft)
          - parseFloat(hostStyle.paddingRight);
        return {
          text: badge.textContent.trim(),
          badge: badge.getBoundingClientRect().width,
          available: inner,
        };
      };
      return { short: read("card-short"), long: read("card-long") };
    });

    // Acceptance: identical width for a short and a long label on same-size cards.
    expect(metrics.short.text).not.toBe(metrics.long.text);
    expect(Math.abs(metrics.short.badge - metrics.long.badge)).toBeLessThanOrEqual(0.5);

    // Acceptance: no horizontal overflow in a flex-row parent. Without
    // box-sizing: border-box the padding and border push this ~18px over.
    for (const m of [metrics.short, metrics.long]) {
      expect(m.badge).toBeLessThanOrEqual(m.available + 0.5);
      expect(m.badge).toBeGreaterThan(m.available * 0.95);
    }

    // Acceptance: still the hit-test winner over .uitk-card-link — now across the
    // whole width, not just a text-sized pill at the centre.
    const hits = await page.evaluate(() => {
      const badge = document.querySelector("#card-short .vdp-search-badge");
      const r = badge.getBoundingClientRect();
      const y = r.top + r.height / 2;
      const at = (x) => {
        const el = document.elementFromPoint(x, y);
        return el && el.closest(".vdp-search-badge") ? "badge" : (el ? el.className : "none");
      };
      return { left: at(r.left + 2), center: at(r.left + r.width / 2), right: at(r.right - 2) };
    });
    expect(hits).toEqual({ left: "badge", center: "badge", right: "badge" });

    await guard.assertNoLeakedRequests(page);
  } finally {
    await context.close();
  }
});
