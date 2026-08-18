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
        // Look for pet-related filter checkboxes in sidebar
        const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
        const petCheckbox = checkboxes.find(el => /pets?|dogs?/i.test(el.name || el.value || el.id || ''));
        if (petCheckbox) {
          if (!petCheckbox.checked) {
            petCheckbox.click();
            return { clicked: true, tag: "INPUT", text: petCheckbox.name };
          }
          return { clicked: false, alreadyChecked: true, text: petCheckbox.name };
        }
        return { clicked: false, totalCheckboxes: checkboxes.length };
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
      contextId,
      expression: `(() => {
        const allLinks = Array.from(document.querySelectorAll('a[href]')).map(a => ({
          href: a.href,
          text: a.textContent.trim().slice(0, 50),
          className: a.className,
          dataStid: a.getAttribute('data-stid') || a.closest('[data-stid]')?.getAttribute('data-stid')
        }));

        const listingLinks = allLinks.filter(l => /vrbo\.com\/(?:\d+|pdp|vacation-rental|hotel)/i.test(l.href) || /\/\d{5,}/.test(l.href));

        const uitkCards = Array.from(document.querySelectorAll('.uitk-card, [class*="card"], [class*="listing"], [class*="property"]')).slice(0, 5).map(el => ({
          tag: el.tagName,
          className: el.className,
          dataStid: el.getAttribute('data-stid'),
          dataTestid: el.getAttribute('data-testid')
        }));

        return {
          totalLinks: allLinks.length,
          listingLinksFound: listingLinks.length,
          sampleListingLinks: listingLinks.slice(0, 5).map(l => l.href),
          sampleCardContainers: uitkCards
        };
      })()`,
      returnByValue: true,
    });
    console.log("\n2. Live DOM Deep Inspection:", JSON.stringify(domRes.result.value, null, 2));

    // 3. Inspect Injected Badges & Verify Card IDs
    const badgeRes = await targetCdp.send("Runtime.evaluate", {
      contextId,
      expression: `(() => {
        const badges = document.querySelectorAll('.vdp-search-badge');
        const badgeDetails = Array.from(badges).map(b => {
          const card = b.closest('[data-vdp-prop-id]');
          const link = card ? card.querySelector('a[href*="/"]') : null;
          return {
            text: b.textContent.trim(),
            className: b.className,
            status: b.dataset.vdpStatus,
            propId: card ? card.getAttribute('data-vdp-prop-id') : null,
            linkHref: link ? link.href : null
          };
        });
        return {
          totalBadges: badges.length,
          sampleBadges: badgeDetails.slice(0, 5)
        };
      })()`,
      returnByValue: true,
    });
    console.log("\n3. Vrbow Search Badges:", JSON.stringify(badgeRes.result.value, null, 2));

    // 4. Assertive Hover, Mouse Gap Transit, Close Button, and Keyboard Flow Verification
    const interactionTestRes = await targetCdp.send("Runtime.evaluate", {
      contextId,
      expression: `(async () => {
        const firstBadge = document.querySelector('.vdp-search-badge');
        if (!firstBadge) return { error: 'No badge found to hover' };

        const parentCard = firstBadge.closest('[data-vdp-prop-id]');
        const expectedPropId = parentCard ? parentCard.getAttribute('data-vdp-prop-id') : null;

        // Step A: Mouse enters badge
        firstBadge.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        await new Promise(r => setTimeout(r, 400));
        const tooltip = document.querySelector('.vdp-search-tooltip');
        const initialVisible = tooltip && tooltip.classList.contains('vdp-tooltip-visible') && tooltip.style.display !== 'none';
        const hasHeader = tooltip && /dog policy/i.test(tooltip.textContent);

        // Step B: Pointer moves across the gap to enter the tooltip (grace period test)
        firstBadge.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true, relatedTarget: tooltip }));
        tooltip.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        await new Promise(r => setTimeout(r, 300));
        const preservedAcrossGap = tooltip && tooltip.classList.contains('vdp-tooltip-visible') && tooltip.style.display !== 'none';

        // Step C: Verify listing link inside tooltip matches listing card
        const tooltipLink = tooltip.querySelector('a[href*="/"]');
        const linkMatchesProp = tooltipLink && expectedPropId && tooltipLink.href.includes(expectedPropId);

        // Step D: Dismiss via Close Button click
        const closeBtn = tooltip.querySelector('.vdp-tooltip-close');
        if (closeBtn) closeBtn.click();
        await new Promise(r => setTimeout(r, 200));
        const dismissedViaClose = tooltip.style.display === 'none';

        // Step E: Keyboard activation (Enter key on badge)
        firstBadge.focus();
        firstBadge.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await new Promise(r => setTimeout(r, 300));
        const openedViaKeyboard = tooltip.style.display !== 'none';

        // Step F: Dismiss via Escape key inside dialog
        tooltip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise(r => setTimeout(r, 200));
        const dismissedViaEscape = tooltip.style.display === 'none';

        return {
          expectedPropId,
          badgeFound: true,
          initialVisible,
          hasHeader,
          preservedAcrossGap,
          linkMatchesProp,
          dismissedViaClose,
          openedViaKeyboard,
          dismissedViaEscape
        };
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    console.log("\n4. Assertive Tooltip & Interaction Verification:", JSON.stringify(interactionTestRes.result.value, null, 2));

    // 5. Verification Assertions
    const totalBadges = badgeRes.result.value?.totalBadges || 0;
    const inter = interactionTestRes.result.value;
    const allInteractionsPassed = inter?.initialVisible &&
      inter?.hasHeader &&
      inter?.preservedAcrossGap &&
      inter?.linkMatchesProp &&
      inter?.dismissedViaClose &&
      inter?.openedViaKeyboard &&
      inter?.dismissedViaEscape;

    console.log("\n══════════════════════════════════════════════════════");
    if (totalBadges === 0) {
      console.error("❌ ASSERTION FAILED: Zero search badges were injected on live page.");
      process.exit(1);
    }
    if (!allInteractionsPassed) {
      console.error("❌ ASSERTION FAILED: Live tooltip interaction checks did not all pass:", inter);
      process.exit(1);
    }

    console.log(`✅ LIVE VERIFICATION PASSED: ${totalBadges} badges injected, interactive mouse gap transit, close button, link matching, and keyboard flows verified.`);
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
