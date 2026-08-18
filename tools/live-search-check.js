#!/usr/bin/env node
//
// tools/live-search-check.js
// Live end-to-end CDP test harness for Vrbo search pages.
//
// Opens Chrome, navigates to a live Vrbo search URL, and inspects:
//   1. Search card DOM selectors ([data-stid="property-card"], etc.)
//   2. window.__APOLLO_STATE__ on the search results page
//   3. Extension badge injection into live cards
//   4. In-flight fetch behavior & response headers/payloads
//   5. Live hover/focus tooltip popover display
//
// Usage:
//   node tools/live-search-check.js
//   node tools/live-search-check.js --url "<custom_search_url>"

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DEFAULT_SEARCH_URL = "https://www.vrbo.com/Hotel-Search?destination=Perdido+Key+Beach%2C+Pensacola%2C+Florida%2C+United+States+of+America&startDate=2026-09-04&endDate=2026-09-07&adults=6&children=3_1&pets=1";

const CHROME_CANDIDATES = [
  path.join(os.homedir(), ".cache/puppeteer/chrome/mac_arm-137.0.7151.0/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
  path.join(os.homedir(), ".cache/puppeteer/chrome/mac_arm-136.0.7082.0/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
  "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

function findChrome() {
  for (const c of CHROME_CANDIDATES) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error("No Chrome binary found. Install Google Chrome or Chrome for Testing.");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readScript(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

async function startChrome(port, extensionDir) {
  const binary = findChrome();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vrbow-search-"));
  const isTesting = /testing|chromium/i.test(binary);

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,900",
  ];

  if (isTesting && extensionDir) {
    args.push(`--load-extension=${extensionDir}`);
    args.push(`--disable-extensions-except=${extensionDir}`);
  }

  args.push("about:blank");

  const proc = spawn(binary, args, { stdio: ["ignore", "ignore", "ignore"] });
  proc.unref();

  for (let i = 0; i < 40; i++) {
    await sleep(200);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return { proc, userDataDir, mode: isTesting ? "extension" : "emulated" };
    } catch {}
  }
  throw new Error("Chrome did not start debugging port in time");
}

class CdpConnection {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 1;
    this.pending = new Map();
    this.events = [];
  }

  async open() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
      this.ws.onmessage = (msg) => {
        const data = JSON.parse(msg.data);
        if (data.id && this.pending.has(data.id)) {
          const { resolve: res, reject: rej } = this.pending.get(data.id);
          this.pending.delete(data.id);
          if (data.error) rej(new Error(data.error.message));
          else res(data.result);
        } else if (data.method) {
          this.events.push(data);
        }
      };
    });
  }

  send(method, params = {}) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.ws.close();
  }
}

async function run() {
  const port = 9333;
  console.log("Starting Chrome for search page verification...");
  const { proc, userDataDir, mode } = await startChrome(port, ROOT);
  console.log(`Chrome started (mode: ${mode}).`);

  let targetCdp = null;

  try {
    const listRes = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = await listRes.json();
    const pageTarget = targets.find((t) => t.type === "page") || targets[0];

    targetCdp = new CdpConnection(pageTarget.webSocketDebuggerUrl);
    await targetCdp.open();

    await targetCdp.send("Page.enable");
    await targetCdp.send("Runtime.enable");
    await targetCdp.send("DOM.enable");

    const searchUrl = process.argv.includes("--url")
      ? process.argv[process.argv.indexOf("--url") + 1]
      : DEFAULT_SEARCH_URL;

    console.log(`Navigating to search URL: ${searchUrl}`);
    await targetCdp.send("Page.navigate", { url: searchUrl });

    console.log("Waiting for search results to load (12s)...");
    await sleep(12000);

    // Click the "Pets allowed" filter in the search results sidebar if available
    console.log("Ensuring 'Pets allowed' filter is applied in search results...");
    const filterApplied = await targetCdp.send("Runtime.evaluate", {
      expression: `(() => {
        // Look for pet-related filter checkboxes or buttons in the sidebar / filter modal
        const filters = Array.from(document.querySelectorAll('input[type="checkbox"], button, label, [data-stid*="filter"]'));
        const petFilter = filters.find(el => /pets? allowed|pet friendly|traveling with pets/i.test(el.textContent || el.getAttribute('aria-label') || el.name || ''));
        if (petFilter) {
          if (petFilter.tagName === 'INPUT' && !petFilter.checked) {
            petFilter.click();
            return { clicked: true, tag: petFilter.tagName, text: petFilter.name };
          } else {
            petFilter.click();
            return { clicked: true, tag: petFilter.tagName, text: petFilter.textContent.trim().slice(0, 40) };
          }
        }
        return { clicked: false, totalElements: filters.length };
      })()`,
      returnByValue: true,
    });
    console.log("Filter interaction result:", JSON.stringify(filterApplied.result.value, null, 2));
    if (filterApplied.result.value?.clicked) {
      console.log("Waiting 6s for filtered search results to settle...");
      await sleep(6000);
    }

    let contextId = undefined;
    if (mode === "emulated") {
      console.log("Emulated mode: Injecting page-bridge into MAIN and content scripts into ISOLATED context...");
      await targetCdp.send("Runtime.evaluate", {
        expression: readScript("page-bridge.js"),
      });

      const { frameTree } = await targetCdp.send("Page.getFrameTree", {});
      const { executionContextId } = await targetCdp.send("Page.createIsolatedWorld", {
        frameId: frameTree.frame.id,
        worldName: "VrbowIsolatedWorld",
      });
      contextId = executionContextId;

      await targetCdp.send("Runtime.evaluate", {
        contextId: executionContextId,
        expression: `globalThis.chrome = { storage: { local: { set(o, cb) { cb && cb(); }, get(k, cb) { cb && cb({}); }, remove(k, cb) { cb && cb(); } } }, runtime: { onMessage: { addListener() {} } } };`,
      });

      for (const file of ["extract.js", "search-fetcher.js", "content.js"]) {
        await targetCdp.send("Runtime.evaluate", { contextId: executionContextId, expression: readScript(file) });
      }
    }

    console.log("Waiting 10s for search queue to fetch initial cards...");
    await sleep(10000);

    // Interrogate Page State
    console.log("\n══════════════════════════════════════════════════════");
    console.log("LIVE PET SEARCH PAGE FINDINGS:");
    console.log("══════════════════════════════════════════════════════\n");

    // 1. Check Search Page Apollo State
    const apolloRes = await targetCdp.send("Runtime.evaluate", {
      expression: `(() => {
        const state = window.__APOLLO_STATE__;
        if (!state) return { hasApollo: false };
        const keys = Object.keys(state);
        return {
          hasApollo: true,
          totalKeys: keys.length,
          keysSample: keys.slice(0, 10)
        };
      })()`,
      returnByValue: true,
    });
    console.log("1. Search Page Apollo State:", JSON.stringify(apolloRes.result.value, null, 2));

    // 2. Discover Search Card DOM elements
    const domRes = await targetCdp.send("Runtime.evaluate", {
      expression: `(() => {
        // Collect all anchors with hrefs on the page
        const allLinks = Array.from(document.querySelectorAll('a[href]')).map(a => ({
          href: a.href,
          text: a.textContent.trim().slice(0, 50),
          className: a.className,
          parentTag: a.parentElement ? a.parentElement.tagName : null,
          parentClass: a.parentElement ? a.parentElement.className : null,
          dataStid: a.getAttribute('data-stid') || a.closest('[data-stid]')?.getAttribute('data-stid')
        }));

        const listingLinks = allLinks.filter(l => /vrbo\.com\/(?:\d+|pdp|vacation-rental|hotel)/i.test(l.href) || /\/\d{5,}/.test(l.href));

        // Inspect .uitk-card structures
        const uitkCards = Array.from(document.querySelectorAll('.uitk-card, [class*="card"], [class*="listing"], [class*="property"]')).slice(0, 5).map(el => ({
          tag: el.tagName,
          className: el.className,
          dataStid: el.getAttribute('data-stid'),
          dataTestid: el.getAttribute('data-testid'),
          innerLinks: Array.from(el.querySelectorAll('a')).map(a => a.href)
        }));

        return {
          totalLinks: allLinks.length,
          listingLinksFound: listingLinks.length,
          sampleListingLinks: listingLinks.slice(0, 8),
          sampleCardContainers: uitkCards
        };
      })()`,
      returnByValue: true,
    });
    console.log("\n2. Live DOM Deep Inspection:", JSON.stringify(domRes.result.value, null, 2));

    // 3. Inspect Injected Badges
    const badgeRes = await targetCdp.send("Runtime.evaluate", {
      expression: `(() => {
        const badges = document.querySelectorAll('.vdp-search-badge');
        const badgeDetails = Array.from(badges).map(b => ({
          text: b.textContent.trim(),
          className: b.className,
          status: b.dataset.vdpStatus,
          propId: b.closest('[data-vdp-prop-id]')?.getAttribute('data-vdp-prop-id')
        }));
        return {
          totalBadges: badges.length,
          sampleBadges: badgeDetails.slice(0, 5)
        };
      })()`,
      returnByValue: true,
    });
    console.log("\n3. Vrbow Search Badges:", JSON.stringify(badgeRes.result.value, null, 2));

    // 2. Direct fetch test to a listing from within page context
    const fetchTestRes = await targetCdp.send("Runtime.evaluate", {
      contextId,
      expression: `(async () => {
        const sampleUrl = "https://www.vrbo.com/3173015";
        try {
          const res = await fetch(sampleUrl, {
            headers: { "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }
          });
          const text = await res.text();
          const parsed = globalThis.VdpSearchFetcher.parseListingHtml(text, "3173015");
          return {
            status: res.status,
            parsed
          };
        } catch (err) {
          return { errorName: err.name, errorMessage: err.message, stack: err.stack };
        }
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    console.log("\n2. Direct Policy Extraction from Live Listing HTML:", JSON.stringify(fetchTestRes.result.value, null, 2));

    console.log("\n══════════════════════════════════════════════════════");
    console.log("LIVE INVESTIGATION COMPLETE");
    console.log("══════════════════════════════════════════════════════\n");
  } finally {
    if (targetCdp) targetCdp.close();
    try {
      proc.kill("SIGKILL");
    } catch {}
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {}
  }
}

run().catch((err) => {
  console.error("Live search check failed:", err);
  process.exit(1);
});
