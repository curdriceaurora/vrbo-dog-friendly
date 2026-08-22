const path = require("node:path");
const fs = require("node:fs");
const { expect, test } = require("@playwright/test");
const { installNetworkGuard } = require("./guardrail.js");
const { BURIED_FEE_PAYLOAD: AIRBNB_NIOBE_CLIENT_DATA } = require("./airbnb-payloads.js");
const { PET_FEE_PAYLOAD: EXPEDIA_PET_FEE_PAYLOAD, pageHtml: expediaPageHtml } = require("./expedia-payloads.js");

const ROOT = path.join(__dirname, "..");
const TARGET_SCRIPTS = new Set(["content.js", "popup.js", "page-bridge.js", "search-fetcher.js", "extract.js", "formatters.js", "site-registry.js", "airbnb-adapter.js", "expedia-adapter.js"]);

function calculateExecutionMask(text, functionEntries) {
  if (!text || text.length === 0) return new Uint8Array(0);
  const bytes = new Uint8Array(text.length);

  for (const fn of functionEntries) {
    for (const range of fn.ranges) {
      const start = Math.max(0, Math.min(range.startOffset, text.length));
      const end = Math.max(0, Math.min(range.endOffset, text.length));
      const val = range.count > 0 ? 1 : 0;
      for (let i = start; i < end; i++) {
        bytes[i] = val;
      }
    }
  }

  return bytes;
}

test("8.2.4: exercises and reports browser-path coverage for production content.js, popup.js, page-bridge.js, and site adapters", async ({ browser }) => {
  const aggregate = new Map();
  const context = await browser.newContext();
  const guard = await installNetworkGuard(context);

  // Read production script contents
  const siteRegistryJs = fs.readFileSync(path.join(ROOT, "src", "shared", "site-registry.js"), "utf8");
  const extractJs = fs.readFileSync(path.join(ROOT, "src", "shared", "extract.js"), "utf8");
  const searchFetcherJs = fs.readFileSync(path.join(ROOT, "src", "shared", "search-fetcher.js"), "utf8");
  const pageBridgeJs = fs.readFileSync(path.join(ROOT, "src", "content", "page-bridge.js"), "utf8");
  const formattersJs = fs.readFileSync(path.join(ROOT, "src", "shared", "formatters.js"), "utf8");
  const contentJs = fs.readFileSync(path.join(ROOT, "src", "content", "content.js"), "utf8");
  const popupJs = fs.readFileSync(path.join(ROOT, "src", "popup", "popup.js"), "utf8");
  const airbnbAdapterJs = fs.readFileSync(path.join(ROOT, "src", "sites", "airbnb", "adapter.js"), "utf8");
  const expediaAdapterJs = fs.readFileSync(path.join(ROOT, "src", "sites", "expedia", "adapter.js"), "utf8");
  const tokensCss = fs.readFileSync(path.join(ROOT, "src", "content", "tokens.css"), "utf8");
  const contentCss = fs.readFileSync(path.join(ROOT, "src", "content", "content.css"), "utf8");
  const popupCss = fs.readFileSync(path.join(ROOT, "src", "popup", "popup.css"), "utf8");

  // Route external script files on context level
  await context.route("https://www.vrbo.com/site-registry.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: siteRegistryJs }));
  await context.route("https://www.vrbo.com/extract.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: extractJs }));
  await context.route("https://www.vrbo.com/search-fetcher.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: searchFetcherJs }));
  await context.route("https://www.vrbo.com/page-bridge.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: pageBridgeJs }));
  await context.route("https://www.vrbo.com/content.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: contentJs }));
  await context.route("https://www.vrbo.com/popup.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: popupJs }));
  await context.route("https://www.vrbo.com/formatters.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: formattersJs }));

  // Airbnb's manifest.json content-script bundle (shared/site-registry.js,
  // sites/airbnb/adapter.js, shared/extract.js, shared/search-fetcher.js,
  // shared/formatters.js, content/content.js — no page-bridge.js, unlike
  // Vrbo's bundle, since Airbnb's data is DOM-reachable directly). Routed
  // separately at the airbnb.com origin even where the file content is
  // identical to the vrbo.com routes above, since Playwright routes match
  // full URLs, not just paths.
  await context.route("https://www.airbnb.com/site-registry.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: siteRegistryJs }));
  await context.route("https://www.airbnb.com/airbnb-adapter.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: airbnbAdapterJs }));
  await context.route("https://www.airbnb.com/extract.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: extractJs }));
  await context.route("https://www.airbnb.com/search-fetcher.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: searchFetcherJs }));
  await context.route("https://www.airbnb.com/formatters.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: formattersJs }));
  await context.route("https://www.airbnb.com/content.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: contentJs }));

  await context.route("https://www.expedia.com/site-registry.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: siteRegistryJs }));
  await context.route("https://www.expedia.com/expedia-adapter.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: expediaAdapterJs }));
  await context.route("https://www.expedia.com/extract.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: extractJs }));
  await context.route("https://www.expedia.com/search-fetcher.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: searchFetcherJs }));
  await context.route("https://www.expedia.com/formatters.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: formattersJs }));
  await context.route("https://www.expedia.com/content.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: contentJs }));

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
        window.__APOLLO_STATE__ = {
          "ROOT_QUERY": {
            "searchResult": {
              "listings": [
                { "__ref": "Listing:100001" },
                { "__ref": "Listing:100002" }
              ]
            }
          },
          "Listing:100001": {
            "id": "100001",
            "summary": { "petsAllowed": true }
          }
        };
        window.chrome = {
          storage: {
            local: {
              store: {
                "vrbow_cache_old": { cacheVersion: 1, expiresAt: Date.now() - 10000 },
                "vrbow_cache_100001": {
                  cacheVersion: 1,
                  propertyId: "100001",
                  expiresAt: Date.now() + 100000,
                  data: {
                    status: "ok",
                    policy: {
                      schemaVersion: 1,
                      petsAllowed: true,
                      maxDogs: 2,
                      weightLimit: { value: 50, unit: "lb" },
                      fee: { amount: 25, currency: "USD", period: "day", perPet: true },
                      deposit: { amount: 100, currency: "USD" },
                      approvalRequired: true,
                      confidence: "high"
                    }
                  }
                }
              },
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
            onMessage: {
              listeners: [],
              addListener(fn) { this.listeners.push(fn); }
            }
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
      <script src="/site-registry.js"></script>
      <script src="/extract.js"></script>
      <script src="/search-fetcher.js"></script>
      <script src="/page-bridge.js"></script>
      <script src="/formatters.js"></script>
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
            text: "Dogs are welcome! Up to 2 pets allowed up to 40 lbs. Pet fee is $150 per stay. Non-refundable deposit $100. Prior approval required."
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
            onMessage: {
              listeners: [],
              addListener(fn) { this.listeners.push(fn); }
            }
          }
        };
      </script>
    </head>
    <body>
      <main>
        <section aria-label="House Rules">
          <h2>House Rules</h2>
          <p id="pet-rule">Dogs are welcome! Up to 2 pets allowed up to 40 lbs. Pet fee is $150 per stay. Non-refundable deposit $100. Prior approval required.</p>
        </section>
      </main>
      <script src="/site-registry.js"></script>
      <script src="/extract.js"></script>
      <script src="/search-fetcher.js"></script>
      <script src="/page-bridge.js"></script>
      <script src="/formatters.js"></script>
      <script src="/content.js"></script>
    </body>
  </html>`;

  // 2b. Airbnb listing page scenario — no page-bridge.js (manifest.json
  // omits it for airbnb.com; the adapter reads #data-deferred-state-0
  // directly instead of an Apollo-state window global). Payload reused from
  // e2e/airbnb-payloads.js (the same BURIED_FEE_PAYLOAD e2e/airbnb-listing.spec.js
  // exercises) rather than hand-duplicated here — this test's job is
  // coverage of the script paths actually exercised by a real page visit,
  // not re-verifying parsing correctness (already covered against the real
  // captured fixtures in test/site-adapters-airbnb.test.js).
  const airbnbListingHtml = `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8">
      <style>${tokensCss}\n${contentCss}</style>
      <script id="data-deferred-state-0" type="application/json">${JSON.stringify({ niobeClientData: AIRBNB_NIOBE_CLIENT_DATA })}</script>
      <script>
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
            onMessage: {
              listeners: [],
              addListener(fn) { this.listeners.push(fn); }
            }
          }
        };
      </script>
    </head>
    <body>
      <script src="/site-registry.js"></script>
      <script src="/airbnb-adapter.js"></script>
      <script src="/extract.js"></script>
      <script src="/search-fetcher.js"></script>
      <script src="/formatters.js"></script>
      <script src="/content.js"></script>
    </body>
  </html>`;

  const expediaListingHtml = expediaPageHtml(EXPEDIA_PET_FEE_PAYLOAD).replace("</head>", `
      <style>${tokensCss}\n${contentCss}</style>
      <script>
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
            onMessage: {
              listeners: [],
              addListener(fn) { this.listeners.push(fn); }
            }
          }
        };
      </script>
    </head>`).replace("</body>", `
      <script src="/site-registry.js"></script>
      <script src="/expedia-adapter.js"></script>
      <script src="/extract.js"></script>
      <script src="/search-fetcher.js"></script>
      <script src="/formatters.js"></script>
      <script src="/content.js"></script>
    </body>`);

  // 3. Popup scenario creator
  function createPopupHtml(tabUrl, policyResponse, lastError = null) {
    return `<!doctype html>
    <html lang="en" class="vdp-theme-root">
      <head>
        <meta charset="utf-8">
        <style>${tokensCss}\n${popupCss}</style>
        <script>
          window.chrome = {
            runtime: {
              lastError: ${lastError ? JSON.stringify({ message: lastError }) : "null"},
              sendMessage(msg, cb) { cb && cb({}); },
            },
            storage: {
              local: {
                get(keys, cb) {
                  cb({
                    vdpLastUrl: "https://www.vrbo.com/123456",
                    vdpLastPolicy: ${JSON.stringify(policyResponse?.policy || null)}
                  });
                },
                set(k, cb) { cb && cb(); }
              }
            },
            tabs: {
              query(opts, cb) { cb([{ id: 101, url: ${JSON.stringify(tabUrl)} }]); },
              sendMessage(id, msg, cb) {
                cb(${JSON.stringify(policyResponse)});
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
        <script src="/formatters.js"></script>
        <script src="/site-registry.js"></script>
        <script src="/popup.js"></script>
      </body>
    </html>`;
  }

  await context.route("https://www.vrbo.com/Hotel-Search*", (route) => {
    route.fulfill({ status: 200, contentType: "text/html", body: searchHtml });
  });

  await context.route("https://www.vrbo.com/123456*", (route) => {
    route.fulfill({ status: 200, contentType: "text/html", body: listingHtml });
  });

  await context.route("https://www.airbnb.com/rooms/42406610*", (route) => {
    route.fulfill({ status: 200, contentType: "text/html", body: airbnbListingHtml });
  });

  await context.route(`${EXPEDIA_PET_FEE_PAYLOAD.url}*`, (route) => {
    route.fulfill({ status: 200, contentType: "text/html", body: expediaListingHtml });
  });

  function collectCoverage(entries) {
    for (const entry of entries) {
      const filename = path.basename(new URL(entry.url, "https://www.vrbo.com/").pathname);
      if (!TARGET_SCRIPTS.has(filename)) continue;

      const srcText = entry.source || entry.text || "";
      let current = aggregate.get(filename);
      if (!current) {
        current = { text: srcText, mask: new Uint8Array(srcText.length) };
        aggregate.set(filename, current);
      } else if ((!current.text || current.text.length === 0) && srcText.length > 0) {
        current.text = srcText;
        current.mask = new Uint8Array(srcText.length);
      }
      const executionMask = calculateExecutionMask(current.text || srcText, entry.functions);
      if (current.mask.length === 0 && executionMask.length > 0) {
        current.mask = new Uint8Array(executionMask.length);
      }
      for (let i = 0; i < current.mask.length; i++) {
        if (executionMask[i] === 1) {
          current.mask[i] = 1;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Execute Search Flow
  // -------------------------------------------------------------------------
  const searchPage = await context.newPage();
  await searchPage.coverage.startJSCoverage();
  await searchPage.goto("https://www.vrbo.com/Hotel-Search?destination=Miami");

  const badge1 = searchPage.locator("#card-1 .vdp-search-badge");
  await expect(badge1).toBeVisible({ timeout: 5000 });

  // Hover quick-view tooltip and keyboard navigation
  await badge1.hover();
  const tooltip = searchPage.locator("#vdp-search-tooltip");
  await expect(tooltip).toBeVisible();

  // Test keyboard trigger and dismiss
  await badge1.focus();
  await searchPage.keyboard.press("Enter");
  await searchPage.keyboard.press("Escape");
  await expect(tooltip).not.toBeVisible();

  // Test status states in updateBadgeUi
  await searchPage.evaluate(() => {
    const card = document.querySelector("#card-1");
    const badge = card.querySelector(".vdp-search-badge");
    // Trigger capped, rate_limited, unknown, and rich allowed status rendering
    badge.dataset.vdpStatus = "";
    card.dispatchEvent(new Event("mouseenter"));
    window.dispatchEvent(new CustomEvent("vdp-search-apollo-data", { detail: { 100001: { petsAllowed: true } } }));
    window.dispatchEvent(new Event("vdp-locationchange"));
  });

  // Recycle Card 1 to Property 3 (Virtualization)
  await searchPage.evaluate(() => {
    const link = document.querySelector("#card-1 a");
    link.href = "https://www.vrbo.com/100003";
    link.textContent = "Recycled Property 3";
  });

  collectCoverage(await searchPage.coverage.stopJSCoverage());
  await searchPage.close();

  // -------------------------------------------------------------------------
  // Execute Listing Flow
  // -------------------------------------------------------------------------
  const listingPage = await context.newPage();
  await listingPage.coverage.startJSCoverage();
  await listingPage.goto("https://www.vrbo.com/123456");

  const panel = listingPage.locator("#vdp-panel");
  await expect(panel).toBeVisible({ timeout: 5000 });
  await expect(panel).toContainText("Dog policy");

  // Toggle expanded and collapsed (starts collapsed by default on constrained viewports)
  await expect(panel).toHaveClass(/vdp-collapsed/);
  await panel.locator(".vdp-header").click();
  await expect(panel).not.toHaveClass(/vdp-collapsed/);
  await panel.locator(".vdp-header").click();
  await expect(panel).toHaveClass(/vdp-collapsed/);

  // Exercise popup message listeners in content script
  await listingPage.evaluate(() => {
    window.dispatchEvent(new CustomEvent("vdp-apollo-data", { detail: { test: true } }));
    window.dispatchEvent(new CustomEvent("vdp-request-apollo-data"));
    // Trigger message listeners
    const listeners = window.chrome?.runtime?.onMessage?.listeners || [];
    for (const fn of listeners) {
      fn({ type: "vdp-get-policy" }, {}, () => {});
      fn({ type: "vdp-rescan" }, {}, () => {});
      fn({ type: "vdp-ping" }, {}, () => {});
    }
  });

  collectCoverage(await listingPage.coverage.stopJSCoverage());
  await listingPage.close();

  // -------------------------------------------------------------------------
  // Execute Airbnb Listing Flow (sites/airbnb/adapter.js browser-path
  // coverage — the airbnb.com content-script bundle shape, not
  // just a Node-level require)
  // -------------------------------------------------------------------------
  const airbnbPage = await context.newPage();
  await airbnbPage.coverage.startJSCoverage();
  await airbnbPage.goto("https://www.airbnb.com/rooms/42406610");

  const airbnbPanel = airbnbPage.locator("#vdp-panel");
  await expect(airbnbPanel).toBeVisible({ timeout: 5000 });
  await expect(airbnbPanel).toContainText("Dog policy");
  // Exercises the buried-fee extraction path (getPdpStructuredPayload's
  // full walk, not just the toggle) rather than the sparse-state branch,
  // for maximal coverage of the adapter's walker.
  await expect(airbnbPanel).toContainText("Fee");

  collectCoverage(await airbnbPage.coverage.stopJSCoverage());
  await airbnbPage.close();

  // -------------------------------------------------------------------------
  // Execute Expedia Listing Flow (sites/expedia/adapter.js browser-path
  // coverage — microdata/JSON-LD adapter path, no page bridge)
  // -------------------------------------------------------------------------
  const expediaPage = await context.newPage();
  await expediaPage.coverage.startJSCoverage();
  await expediaPage.goto(EXPEDIA_PET_FEE_PAYLOAD.url);

  const expediaPanel = expediaPage.locator("#vdp-panel");
  await expect(expediaPanel).toBeVisible({ timeout: 5000 });
  await expect(expediaPanel).toContainText("Dog policy");
  await expect(expediaPanel).toContainText("Fee");

  collectCoverage(await expediaPage.coverage.stopJSCoverage());
  await expediaPage.close();

  // -------------------------------------------------------------------------
  // Execute Popup Flows across All Policy Branches
  // -------------------------------------------------------------------------
  const popupScenarios = [
    // 1. Populated listing with fees, deposit, and notes
    {
      url: "https://www.vrbo.com/popup-pop.html",
      html: createPopupHtml("https://www.vrbo.com/123456", {
        policy: {
          schemaVersion: 1,
          petsAllowed: true,
          maxDogs: 2,
          weightLimit: { value: 50, unit: "lb" },
          fee: { amount: 150, currency: "USD", period: "stay", perPet: true },
          deposit: { amount: 200, currency: "USD" },
          approvalRequired: true,
          restrictionsFound: true,
          _raw: { found: true, preReg: true, otherNotes: ["Breed restrictions apply."] }
        }
      })
    },
    // 2. No pets allowed policy
    {
      url: "https://www.vrbo.com/popup-nopets.html",
      html: createPopupHtml("https://www.vrbo.com/999999", {
        policy: {
          petsAllowed: false,
          _raw: { petsAllowedSnippet: "No pets of any kind are permitted." }
        }
      })
    },
    // 3. Search page notice
    {
      url: "https://www.vrbo.com/popup-search.html",
      html: createPopupHtml("https://www.vrbo.com/search?destination=Miami", null)
    },
    // 4. Non-Vrbo page
    {
      url: "https://www.vrbo.com/popup-notvrbo.html",
      html: createPopupHtml("https://www.google.com", null)
    },
    // 5. Empty policy / not found
    {
      url: "https://www.vrbo.com/popup-empty.html",
      html: createPopupHtml("https://www.vrbo.com/555555", {
        policy: { petsAllowed: null, _raw: { found: false } }
      })
    },
    // 6. Runtime error with storage fallback
    {
      url: "https://www.vrbo.com/popup-fallback.html",
      html: createPopupHtml("https://www.vrbo.com/123456", null, "Port closed")
    }
  ];

  for (const sc of popupScenarios) {
    await context.route(sc.url + "*", (r) => r.fulfill({ status: 200, contentType: "text/html", body: sc.html }));
    const p = await context.newPage();
    await p.coverage.startJSCoverage();
    await p.goto(sc.url);
    const rescanBtn = p.locator("#rescan");
    if (await rescanBtn.count() > 0) {
      await rescanBtn.click();
    }
    collectCoverage(await p.coverage.stopJSCoverage());
    await p.close();
  }

  await guard.assertNoLeakedRequests();
  await context.close();

  console.log("\n===============================================================================");
  console.log("8.2.4 Browser-Path JavaScript Coverage Report");
  console.log("===============================================================================");

  for (const script of ["content.js", "popup.js", "page-bridge.js", "airbnb-adapter.js", "expedia-adapter.js"]) {
    const cov = aggregate.get(script);
    let covered = 0;
    if (cov && cov.mask) {
      for (let i = 0; i < cov.mask.length; i++) {
        if (cov.mask[i] === 1) covered++;
      }
    }
    const percent = (cov && cov.mask && cov.mask.length > 0) ? (covered / cov.mask.length) * 100 : 0;
    console.log(`ℹ [Browser] ${script.padEnd(20)} | Executed Path: ${percent.toFixed(2)}%`);
    expect(percent, `${script} browser-path coverage must be > 0`).toBeGreaterThan(0);
  }

  console.log("===============================================================================\n");
});
