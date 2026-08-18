const path = require("node:path");
const { chromium, expect, test } = require("@playwright/test");

const EXTENSION_ROOT = path.join(__dirname, "..");
const SEARCH_URL = "https://www.vrbo.com/Hotel-Search?destination=LakeTahoe&house_rules_group=pets_allowed";
const LISTING_C_URL = "https://www.vrbo.com/3000003";

const SEARCH_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Virtualization Test Search</title></head>
  <body>
    <main id="search-main">
      <div class="Results">
        <div data-stid="property-card" id="card-1">
          <div class="uitk-card-content">
            <a href="https://www.vrbo.com/1000001?chkin=2026-09-01&adults=2">Cabin A</a>
          </div>
        </div>
      </div>
    </main>
  </body>
</html>`;

const LISTING_A_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Property A - No Pets</title></head>
  <body>
    <main>
      <section aria-label="House Rules">
        <h2>House Rules</h2>
        <p>No pets allowed under any circumstances. Strict violation fee.</p>
      </section>
    </main>
  </body>
</html>`;

const LISTING_B_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Property B - Dogs Allowed</title></head>
  <body>
    <main>
      <section aria-label="House Rules">
        <h2>House Rules</h2>
        <p>Pets welcome! Maximum 2 dogs allowed up to 50 lbs. $50 pet fee applies.</p>
      </section>
    </main>
  </body>
</html>`;

const LISTING_C_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Property C - Listing View</title></head>
  <body>
    <main>
      <section aria-label="House Rules">
        <h2>House Rules</h2>
        <p>Dogs allowed. 1 dog welcome.</p>
      </section>
    </main>
  </body>
</html>`;

test("8.1.5: exercises card recycling, out-of-order response isolation, and SPA navigation with real extension", async () => {
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

    // Deferred promise to hold Property A response in flight
    let resolveA;
    const promiseA = new Promise((r) => { resolveA = r; });

    await page.route("https://www.vrbo.com/Hotel-Search*", (route) => route.fulfill({
      status: 200,
      contentType: "text/html",
      body: SEARCH_HTML
    }));

    await page.route("https://www.vrbo.com/1000001*", async (route) => {
      await promiseA;
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: LISTING_A_HTML
      });
    });

    await page.route("https://www.vrbo.com/2000002*", (route) => route.fulfill({
      status: 200,
      contentType: "text/html",
      body: LISTING_B_HTML
    }));

    await page.route("https://www.vrbo.com/3000003*", (route) => route.fulfill({
      status: 200,
      contentType: "text/html",
      body: LISTING_C_HTML
    }));

    // 1. Initial navigation to search page
    await page.goto(SEARCH_URL);

    const card = page.locator("#card-1");
    await expect(card).toBeVisible();

    // Verify initial binding to Property A
    const badge = card.locator(".vdp-search-badge");
    await expect(badge).toBeVisible({ timeout: 6_000 });
    await expect(badge).toHaveClass(/vdp-badge-loading/);
    await expect(badge).toContainText("Checking pet policy");
    await expect(card).toHaveAttribute("data-vdp-prop-id", "1000001");

    // 2. Recycle the existing card element to Property B while Property A is in-flight
    await page.evaluate(() => {
      const cardEl = document.getElementById("card-1");
      const link = cardEl.querySelector("a");
      link.href = "https://www.vrbo.com/2000002?chkin=2026-09-01&adults=2";
      link.textContent = "Cabin B";

      // Mutate the DOM inside card to trigger the production MutationObserver
      const trigger = document.createElement("span");
      trigger.className = "recycled-mutation-trigger";
      cardEl.appendChild(trigger);
    });

    // Verify card re-binds to Property B
    await expect(card).toHaveAttribute("data-vdp-prop-id", "2000002", { timeout: 6_000 });
    await expect(card).toHaveAttribute("data-vdp-fetch-url", "https://www.vrbo.com/2000002");
    await expect(card).toHaveAttribute("data-vdp-nav-url", "https://www.vrbo.com/2000002?chkin=2026-09-01&adults=2");

    // 3. Property B response resolves first
    await expect(badge).toHaveClass(/vdp-badge-allowed/, { timeout: 6_000 });
    await expect(badge).toContainText(/dogs allowed/i);
    await expect(card.locator(".vdp-search-badge")).toHaveCount(1);

    // Verify tooltip shows Property B and targets Property B navigation URL
    await badge.focus();
    await page.keyboard.press("Enter");
    const tooltip = page.locator(".vdp-search-tooltip");
    await expect(tooltip).toBeVisible();
    const tooltipLink = tooltip.locator(".vdp-tooltip-footer a");
    await expect(tooltipLink).toHaveAttribute("href", "https://www.vrbo.com/2000002?chkin=2026-09-01&adults=2");

    // Close tooltip
    await page.keyboard.press("Escape");
    await expect(tooltip).not.toBeVisible();

    // 4. Now deliver delayed Property A response (which is "No pets allowed")
    resolveA();
    await page.waitForTimeout(200);

    // 5. Assert that delayed Property A response CANNOT overwrite Property B
    await expect(badge).toHaveClass(/vdp-badge-allowed/);
    await expect(badge).toContainText(/dogs allowed/i);
    await expect(badge).not.toHaveClass(/vdp-badge-banned/);
    await expect(card).toHaveAttribute("data-vdp-prop-id", "2000002");
    await expect(card.locator(".vdp-search-badge")).toHaveCount(1);

    // Verify tooltip still targets Property B
    await badge.focus();
    await page.keyboard.press("Enter");
    await expect(tooltip).toBeVisible();
    await expect(tooltipLink).toHaveAttribute("href", "https://www.vrbo.com/2000002?chkin=2026-09-01&adults=2");
    await page.keyboard.press("Escape");
    await expect(tooltip).not.toBeVisible();

    // 6. Test SPA Navigation: Search -> Listing -> Back
    await page.goto(LISTING_C_URL);

    // On listing page, search badges and tooltips should be cleaned up, and listing panel attached
    const panel = page.locator("#vdp-panel");
    await expect(panel).toBeVisible({ timeout: 6_000 });
    await expect(panel).toContainText("Dog-friendly");
    await expect(page.locator(".vdp-search-badge")).toHaveCount(0);

    // Navigate back to search page
    await page.goBack();
    const restoredCard = page.locator("#card-1");
    await expect(restoredCard).toBeVisible({ timeout: 6_000 });
    const restoredBadge = restoredCard.locator(".vdp-search-badge");
    await expect(restoredBadge).toBeVisible();
    await expect(page.locator(".vdp-search-tooltip")).toHaveCount(1);

    // 7. Verify zero uncaught errors
    expect(pageErrors).toEqual([]);
  } finally {
    await context.close();
  }
});

// I3: a card that is recycled to a new href while it is off-screen must not
// fetch. The assertion is a REQUEST COUNT against the mock route handler, not
// an "was it intercepted" check: every request in this suite is intercepted by
// design, so interception proves only that no live traffic left the browser. A
// mocked request has still fired. Counting handler invocations is what
// distinguishes "no fetch happened" from "the fetch was caught".
const SEARCH_OFFSCREEN_URL = "https://www.vrbo.com/Hotel-Search?destination=Tahoe&virtualized=1";

const SEARCH_OFFSCREEN_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Off-screen Recycle Test</title></head>
  <body>
    <main id="search-main">
      <!-- Pushes the card far below the fold, well past the observer's 150px rootMargin. -->
      <div id="spacer" style="height: 4000px"></div>
      <div class="Results">
        <div data-stid="property-card" id="card-1">
          <div class="uitk-card-content">
            <a href="https://www.vrbo.com/1000001?chkin=2026-09-01&adults=2">Cabin A</a>
          </div>
        </div>
      </div>
      <div id="tail-spacer" style="height: 2000px"></div>
    </main>
  </body>
</html>`;

test("I3: recycling an off-screen card to a new href fires zero listing requests until it is scrolled into view", async () => {
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

    // Handler invocation counters — the actual acceptance measurement.
    const requestCounts = { "1000001": 0, "2000002": 0 };

    await page.route("https://www.vrbo.com/Hotel-Search*", (route) => route.fulfill({
      status: 200,
      contentType: "text/html",
      body: SEARCH_OFFSCREEN_HTML
    }));

    await page.route("https://www.vrbo.com/1000001*", (route) => {
      requestCounts["1000001"]++;
      return route.fulfill({ status: 200, contentType: "text/html", body: LISTING_A_HTML });
    });

    await page.route("https://www.vrbo.com/2000002*", (route) => {
      requestCounts["2000002"]++;
      return route.fulfill({ status: 200, contentType: "text/html", body: LISTING_B_HTML });
    });

    await page.goto(SEARCH_OFFSCREEN_URL);

    const card = page.locator("#card-1");
    const badge = card.locator(".vdp-search-badge");

    // The card binds and badges even while off-screen; only the fetch is gated.
    await expect(card).toHaveAttribute("data-vdp-prop-id", "1000001", { timeout: 6_000 });
    await expect(badge).toHaveClass(/vdp-badge-loading/);

    // Comfortably past the dwell window (400ms + up to 200ms jitter) and the
    // queue's dispatch delay.
    await page.waitForTimeout(2_000);
    expect(requestCounts["1000001"]).toBe(0);

    // Recycle the off-screen node to a different property, exactly as a
    // virtualized list does, and poke the production MutationObserver.
    await page.evaluate(() => {
      const cardEl = document.getElementById("card-1");
      const link = cardEl.querySelector("a");
      link.href = "https://www.vrbo.com/2000002?chkin=2026-09-01&adults=2";
      link.textContent = "Cabin B";
      const trigger = document.createElement("span");
      trigger.className = "recycled-mutation-trigger";
      cardEl.appendChild(trigger);
    });

    // Re-binding still happens off-screen — this is a fetch gate, not a bind gate.
    await expect(card).toHaveAttribute("data-vdp-prop-id", "2000002", { timeout: 6_000 });
    await expect(card).toHaveAttribute("data-vdp-fetch-url", "https://www.vrbo.com/2000002");

    await page.waitForTimeout(2_000);
    expect(requestCounts["2000002"]).toBe(0);
    expect(requestCounts["1000001"]).toBe(0);
    await expect(badge).toHaveClass(/vdp-badge-loading/);

    // The gate must be a gate, not a permanent block: scrolling the card into
    // view releases exactly one request for the property it now shows.
    await card.scrollIntoViewIfNeeded();
    await expect(badge).toHaveClass(/vdp-badge-allowed/, { timeout: 8_000 });
    await expect(badge).toContainText(/dogs allowed/i);
    expect(requestCounts["2000002"]).toBe(1);
    expect(requestCounts["1000001"]).toBe(0);

    expect(pageErrors).toEqual([]);
  } finally {
    await context.close();
  }
});
