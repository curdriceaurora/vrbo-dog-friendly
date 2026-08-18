const path = require("node:path");
const fs = require("node:fs");
const { expect, test } = require("@playwright/test");

const ROOT = path.join(__dirname, "..");
const TARGET_SCRIPTS = new Set(["content.js", "popup.js", "page-bridge.js", "search-fetcher.js", "extract.js"]);

function calculateV8Coverage(text, functionEntries) {
  if (!text || text.length === 0) return 100;
  const bytes = new Uint8Array(text.length);

  for (const fn of functionEntries) {
    for (const range of fn.ranges) {
      const val = range.count > 0 ? 1 : 0;
      const start = Math.max(0, Math.min(range.startOffset, text.length));
      const end = Math.max(0, Math.min(range.endOffset, text.length));
      for (let i = start; i < end; i++) {
        bytes[i] = val;
      }
    }
  }

  let covered = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 1) covered++;
  }

  return (covered / bytes.length) * 100;
}

test("8.2.4: exercises and reports browser-path coverage for production content.js, popup.js, and page-bridge.js", async ({ browser }) => {
  const aggregate = new Map();
  const context = await browser.newContext();

  // Read production script contents
  const extractJs = fs.readFileSync(path.join(ROOT, "extract.js"), "utf8");
  const searchFetcherJs = fs.readFileSync(path.join(ROOT, "search-fetcher.js"), "utf8");
  const pageBridgeJs = fs.readFileSync(path.join(ROOT, "page-bridge.js"), "utf8");
  const contentJs = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
  const popupJs = fs.readFileSync(path.join(ROOT, "popup.js"), "utf8");
  const tokensCss = fs.readFileSync(path.join(ROOT, "tokens.css"), "utf8");
  const contentCss = fs.readFileSync(path.join(ROOT, "content.css"), "utf8");
  const popupCss = fs.readFileSync(path.join(ROOT, "popup.css"), "utf8");

  // Route external script files on context level
  await context.route("https://www.vrbo.com/extract.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: extractJs }));
  await context.route("https://www.vrbo.com/search-fetcher.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: searchFetcherJs }));
  await context.route("https://www.vrbo.com/page-bridge.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: pageBridgeJs }));
  await context.route("https://www.vrbo.com/content.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: contentJs }));
  await context.route("https://www.vrbo.com/popup.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: popupJs }));

  // Route mock listing fetch responses
  await context.route("https://www.vrbo.com/100001*", (r) => r.fulfill({
    status: 200,
    contentType: "text/html",
    body: "<html><body><section>House Rules: Dogs allowed. Max 2 dogs up to 50 lbs. $25 per pet per day.</section></body></html>"
  }));

  await context.route("https://www.vrbo.com/100002*", (r) => r.fulfill({
    status: 200,
    contentType: "text/html",
    body: "<html><body><section>House Rules: No pets allowed.</section></body></html>"
  }));

  await context.route("https://www.vrbo.com/100003*", (r) => r.fulfill({
    status: 200,
    contentType: "text/html",
    body: "<html><body><section>House Rules: Dogs allowed.</section></body></html>"
  }));

  // 1. Search page scenario
  const searchHtml = `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8">
      <style>${tokensCss}\n${contentCss}</style>
      <script>
        window.chrome = {
          storage: {
            local: {
              store: {},
              get(keys, cb) {
                if (!keys) return cb({ ...this.store });
                const res = {};
                for (const k of (Array.isArray(keys) ? keys : [keys])) {
                  if (this.store[k]) res[k] = this.store[k];
                }
                cb(res);
              },
              set(items, cb) {
                Object.assign(this.store, items);
                cb && cb();
              },
              remove(keys, cb) {
                for (const k of (Array.isArray(keys) ? keys : [keys])) delete this.store[k];
                cb && cb();
              }
            }
          },
          runtime: {
            sendMessage(msg, cb) { cb && cb({}); },
            onMessage: { addListener() {} }
          }
        };
      </script>
    </head>
    <body>
      <div class="Results">
        <div id="card-1" data-stid="property-card">
          <a href="https://www.vrbo.com/100001">Seaside Villa</a>
        </div>
        <div id="card-2" data-stid="property-card">
          <a href="https://www.vrbo.com/100002">Mountain Cabin</a>
        </div>
      </div>
      <script src="/extract.js"></script>
      <script src="/search-fetcher.js"></script>
      <script src="/page-bridge.js"></script>
      <script src="/content.js"></script>
    </body>
  </html>`;

  // 2. Listing page scenario
  const listingHtml = `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8">
      <style>${tokensCss}\n${contentCss}</style>
      <script>
        window.__APOLLO_STATE__ = {
          "PropertyInfo:123456": {
            rules: { __ref: "Rules:123" }
          },
          "Rules:123": {
            header: { text: "House Rules" },
            text: "Dogs are welcome! Up to 2 pets allowed. Pet fee is $150 per stay."
          }
        };
        window.chrome = {
          storage: {
            local: {
              store: {},
              get(k, cb) { cb({}); },
              set(k, cb) { cb && cb(); }
            }
          },
          runtime: {
            sendMessage(msg, cb) { cb && cb({}); },
            onMessage: { addListener() {} }
          }
        };
      </script>
    </head>
    <body>
      <main>
        <section aria-label="House Rules">
          <h2>House Rules</h2>
          <p id="pet-rule">Dogs are welcome! Up to 2 pets allowed. Pet fee is $150 per stay.</p>
        </section>
      </main>
      <script src="/extract.js"></script>
      <script src="/search-fetcher.js"></script>
      <script src="/page-bridge.js"></script>
      <script src="/content.js"></script>
    </body>
  </html>`;

  // 3. Popup scenario
  const popupHtml = `<!doctype html>
  <html lang="en" class="vdp-theme-root">
    <head>
      <meta charset="utf-8">
      <style>${tokensCss}\n${popupCss}</style>
      <script>
        window.chrome = {
          runtime: {
            lastError: null,
            sendMessage(msg, cb) { cb && cb({}); },
          },
          storage: {
            local: {
              get(k, cb) { cb({}); },
              set(k, cb) { cb && cb(); }
            }
          },
          tabs: {
            query(opts, cb) { cb([{ id: 101, url: "https://www.vrbo.com/123456" }]); },
            sendMessage(id, msg, cb) {
              cb({
                policy: {
                  schemaVersion: 1,
                  petsAllowed: true,
                  maxDogs: 2,
                  weightLimit: { value: 50, unit: "lb" },
                  fee: { amount: 150, currency: "USD", period: "stay" },
                  deposit: { amount: 200, currency: "USD" },
                  approvalRequired: true,
                  restrictionsFound: true,
                  _raw: { found: true, preReg: true, otherNotes: ["Breed restrictions apply."] }
                }
              });
            }
          }
        };
      </script>
    </head>
    <body>
      <div class="wrap">
        <div class="head">
          <div class="title">🐾 Dog Policy</div>
          <button id="rescan" type="button">Rescan</button>
        </div>
        <div id="content"></div>
      </div>
      <script src="/extract.js"></script>
      <script src="/popup.js"></script>
    </body>
  </html>`;

  await context.route("https://www.vrbo.com/Hotel-Search*", (route) => {
    route.fulfill({ status: 200, contentType: "text/html", body: searchHtml });
  });

  await context.route("https://www.vrbo.com/123456*", (route) => {
    route.fulfill({ status: 200, contentType: "text/html", body: listingHtml });
  });

  await context.route("https://www.vrbo.com/popup.html*", (route) => {
    route.fulfill({ status: 200, contentType: "text/html", body: popupHtml });
  });

  function collectCoverage(entries) {
    for (const entry of entries) {
      const filename = path.basename(new URL(entry.url, "https://www.vrbo.com/").pathname);
      if (!TARGET_SCRIPTS.has(filename)) continue;

      const current = aggregate.get(filename) || { text: entry.source || entry.text || "", functions: [] };
      if (!current.text && (entry.source || entry.text)) {
        current.text = entry.source || entry.text;
      }
      current.functions.push(...entry.functions);
      aggregate.set(filename, current);
    }
  }

  // Execute Search Flow
  const searchPage = await context.newPage();
  await searchPage.coverage.startJSCoverage();
  await searchPage.goto("https://www.vrbo.com/Hotel-Search?destination=Miami");

  const badge1 = searchPage.locator("#card-1 .vdp-search-badge");
  await expect(badge1).toBeVisible({ timeout: 5000 });
  await expect(badge1).toContainText("Dogs allowed");

  const badge2 = searchPage.locator("#card-2 .vdp-search-badge");
  await expect(badge2).toBeVisible({ timeout: 5000 });
  await expect(badge2).toContainText("Pets not allowed");

  // Hover & Focus quick-view tooltip
  await badge1.hover();
  const tooltip = searchPage.locator("#vdp-search-tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText("Maximum dogs");

  // Keyboard navigation inside tooltip
  await badge1.focus();
  await searchPage.keyboard.press("Enter");
  const closeBtn = tooltip.locator(".vdp-tooltip-close");
  await closeBtn.focus();
  await searchPage.keyboard.press("Tab");
  await searchPage.keyboard.press("Shift+Tab");
  await searchPage.keyboard.press("Escape");
  await expect(tooltip).not.toBeVisible();

  // Recycle Card 1 to Property 3 (Virtualization)
  await searchPage.evaluate(() => {
    const link = document.querySelector("#card-1 a");
    link.href = "https://www.vrbo.com/100003";
    link.textContent = "Recycled Property 3";
  });

  collectCoverage(await searchPage.coverage.stopJSCoverage());
  await searchPage.close();

  // Execute Listing Flow
  const listingPage = await context.newPage();
  await listingPage.coverage.startJSCoverage();
  await listingPage.goto("https://www.vrbo.com/123456");

  const panel = listingPage.locator("#vdp-panel");
  await expect(panel).toBeVisible({ timeout: 5000 });
  await expect(panel).toContainText("Dog-friendly");

  // Collapse and expand panel
  await panel.locator(".vdp-header").click();
  await expect(panel).toHaveClass(/vdp-collapsed/);
  await panel.locator(".vdp-header").click();
  await expect(panel).not.toHaveClass(/vdp-collapsed/);

  // Jump to rule
  const jump = panel.locator(".vdp-jump").first();
  if (await jump.count() > 0) {
    await jump.click();
  }

  collectCoverage(await listingPage.coverage.stopJSCoverage());
  await listingPage.close();

  // Execute Popup Flow with populated policy and approval required
  const popupPage = await context.newPage();
  const popupErrors = [];
  popupPage.on("pageerror", (err) => popupErrors.push(err));

  await popupPage.coverage.startJSCoverage();
  await popupPage.goto("https://www.vrbo.com/popup.html");
  const rescan = popupPage.locator("#rescan");
  await expect(rescan).toBeVisible();

  // Assert populated rows render without crashing
  const rows = popupPage.locator("#content .row");
  await expect(rows).toHaveCount(5);
  await expect(popupPage.locator("#content")).toContainText("Pre-registration");
  await expect(popupPage.locator("#content")).toContainText("Required");
  await expect(popupPage.locator("#content")).toContainText("Refundable deposit");
  expect(popupErrors).toHaveLength(0);

  await rescan.click();

  collectCoverage(await popupPage.coverage.stopJSCoverage());
  await popupPage.close();

  await context.close();

  console.log("\n===============================================================================");
  console.log("8.2.4 Browser-Path JavaScript Coverage Report");
  console.log("===============================================================================");

  for (const script of ["content.js", "popup.js", "page-bridge.js"]) {
    const cov = aggregate.get(script);
    const percent = cov ? calculateV8Coverage(cov.text, cov.functions) : 0;
    console.log(`ℹ [Browser] ${script.padEnd(20)} | Executed Path: ${percent.toFixed(2)}%`);
    expect(percent, `${script} browser-path coverage must be > 0`).toBeGreaterThan(0);
  }

  console.log("===============================================================================\n");
});
