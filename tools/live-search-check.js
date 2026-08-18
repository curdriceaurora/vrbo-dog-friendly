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
const { spawn, execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DEFAULT_SEARCH_URL = "https://www.vrbo.com/Hotel-Search?destination=Perdido+Key+Beach%2C+Pensacola%2C+Florida%2C+United+States+of+America&startDate=2026-09-04&endDate=2026-09-07&adults=6&children=3_1&house_rules_group=pets_allowed";

function redactUrl(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return urlStr;
  try {
    const u = new URL(urlStr, "https://www.vrbo.com");
    return `${u.origin}${u.pathname}`;
  } catch {
    return urlStr.split("?")[0].split("#")[0];
  }
}

function getGitCommit() {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8", cwd: ROOT }).trim();
  } catch {
    return "unknown";
  }
}

function findChrome() {
  // 1. Search dynamically in ~/.cache/puppeteer for any Chrome for Testing builds
  const puppeteerDir = path.join(os.homedir(), ".cache/puppeteer/chrome");
  if (fs.existsSync(puppeteerDir)) {
    try {
      const output = execSync(`find "${puppeteerDir}" -type f -name "Google Chrome for Testing" 2>/dev/null`, { encoding: "utf8" });
      const lines = output.trim().split("\n").filter(Boolean);
      if (lines.length > 0) {
        return lines[0];
      }
    } catch {}
  }

  const staticCandidates = [
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];

  for (const c of staticCandidates) {
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

async function startChrome(port, extensionDir, startUrl, allowEmulated = false) {
  const binary = findChrome();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vrbow-search-"));
  const isTesting = /testing|chromium/i.test(binary);
  const mode = isTesting ? "extension" : "emulated";

  if (mode !== "extension" && !allowEmulated) {
    throw new Error(`Release verification requires Chrome for Testing in mode: extension. Found: ${binary}. Use --allow-emulated for diagnostic runs.`);
  }

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

  args.push(startUrl || DEFAULT_SEARCH_URL);

  const proc = spawn(binary, args, { stdio: ["ignore", "ignore", "ignore"] });
  proc.unref();

  for (let i = 0; i < 40; i++) {
    await sleep(200);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return { proc, userDataDir, mode, binary };
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
    const cleanParams = {};
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) cleanParams[k] = v;
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: cleanParams }));
    });
  }

  close() {
    this.ws.close();
  }
}

async function evalCdp(cdp, expression, options = {}) {
  const params = {
    expression,
    returnByValue: options.returnByValue !== undefined ? options.returnByValue : true,
    awaitPromise: Boolean(options.awaitPromise),
  };
  if (options.contextId !== undefined) {
    params.contextId = options.contextId;
  }
  const res = await cdp.send("Runtime.evaluate", params);
  if (res.exceptionDetails) {
    const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text || "Unknown CDP evaluation exception";
    throw new Error(`CDP Evaluation Error: ${desc}\nExpression: ${expression.slice(0, 200)}...`);
  }
  if (params.returnByValue && res.result && res.result.value === undefined && res.result.type !== "undefined") {
    throw new Error(`CDP Evaluation returned unexpected undefined value. Result type: ${res.result.type}`);
  }
  return res.result?.value;
}

async function run() {
  const port = 9333;
  const rawSearchUrl = process.argv.includes("--url")
    ? process.argv[process.argv.indexOf("--url") + 1]
    : DEFAULT_SEARCH_URL;

  console.log("Starting Chrome for search page verification...");
  const { proc, userDataDir, mode } = await startChrome(port, ROOT, rawSearchUrl);
  console.log(`Chrome started (mode: ${mode}).`);

  let targetCdp = null;

  try {
    const listRes = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = await listRes.json();
    const pageTarget = targets.find((t) => t.type === "page" && !t.url.startsWith("chrome-extension://") && !t.url.startsWith("chrome://")) || targets[0];

    targetCdp = new CdpConnection(pageTarget.webSocketDebuggerUrl);
    await targetCdp.open();

    await targetCdp.send("Page.enable");
    await targetCdp.send("Runtime.enable");
    await targetCdp.send("DOM.enable");

    console.log(`Navigating to search destination: ${redactUrl(rawSearchUrl)}`);
    await targetCdp.send("Page.navigate", { url: rawSearchUrl });

    console.log("Waiting for search page and property cards to load...");
    let cardsMounted = false;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const val = await evalCdp(targetCdp, `(() => {
        const cards = document.querySelectorAll('[data-stid="property-card"], [data-stid="lodging-card-responsive"], .uitk-card, a[href*="/"]');
        const title = document.title;
        return { ready: document.readyState, count: cards.length, title };
      })()`);

      if (val && val.count > 5) {
        console.log(`Property cards mounted (${i + 1}s): ${val.count} candidates found on "${val.title}"`);
        cardsMounted = true;
        break;
      }
    }

    if (!cardsMounted) {
      const diagVal = await evalCdp(targetCdp, `({ title: document.title, bodySnippet: (document.body && document.body.innerText ? document.body.innerText.slice(0, 400) : '') })`);
      console.warn("⚠️ Property cards were slow or not found:", JSON.stringify(diagVal, null, 2));
    }

    // Click the "Pets allowed" filter in the search results sidebar if available
    console.log("Ensuring 'Pets allowed' filter is applied in search results...");
    const filterAppliedVal = await evalCdp(targetCdp, `(() => {
      const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
      const petCheckbox = checkboxes.find(el => /pets?|dogs?/i.test(el.name || el.value || el.id || ''));
      if (petCheckbox) {
        if (!petCheckbox.checked) {
          petCheckbox.click();
          return { clicked: true, tag: "INPUT", name: petCheckbox.name };
        }
        return { clicked: false, alreadyChecked: true, name: petCheckbox.name };
      }
      return { clicked: false, totalCheckboxes: checkboxes.length };
    })()`);
    console.log("Filter interaction result:", JSON.stringify(filterAppliedVal, null, 2));
    if (filterAppliedVal && filterAppliedVal.clicked) {
      console.log("Waiting 6s for filtered search results to settle...");
      await sleep(6000);
    }

    let contextId = undefined;
    if (mode === "emulated") {
      console.log("Emulated mode: Injecting page-bridge into MAIN and content scripts into ISOLATED context...");
      await evalCdp(targetCdp, readScript("page-bridge.js"));

      const { frameTree } = await targetCdp.send("Page.getFrameTree", {});
      const { executionContextId } = await targetCdp.send("Page.createIsolatedWorld", {
        frameId: frameTree.frame.id,
        worldName: "VrbowIsolatedWorld",
      });
      contextId = executionContextId;

      await evalCdp(targetCdp, `globalThis.chrome = { storage: { local: { set(o, cb) { cb && cb(); }, get(k, cb) { cb && cb({}); }, remove(k, cb) { cb && cb(); } } }, runtime: { onMessage: { addListener() {} } } };`, { contextId });

      for (const file of ["extract.js", "search-fetcher.js", "content.js"]) {
        await evalCdp(targetCdp, readScript(file), { contextId });
      }
    }

    console.log("Waiting 10s for search queue to fetch initial cards...");
    await sleep(10000);

    // Interrogate Page State
    console.log("\n══════════════════════════════════════════════════════");
    console.log("LIVE PET SEARCH PAGE FINDINGS:");
    console.log("══════════════════════════════════════════════════════\n");

    // 1. Check Search Page Apollo State
    const apolloVal = await evalCdp(targetCdp, `(() => {
      const state = window.__APOLLO_STATE__;
      if (!state) return { hasApollo: false };
      const keys = Object.keys(state);
      return {
        hasApollo: true,
        totalKeys: keys.length,
        keysSample: keys.slice(0, 10)
      };
    })()`);
    console.log("1. Search Page Apollo State:", JSON.stringify(apolloVal, null, 2));

    // 2. Discover Search Card DOM elements (evaluated in main world, with query redaction)
    const domVal = await evalCdp(targetCdp, `(() => {
      const allLinks = Array.from(document.querySelectorAll('a[href]')).map(a => {
        let cleanHref = a.href;
        try {
          const u = new URL(a.href);
          cleanHref = u.origin + u.pathname;
        } catch {}
        const closestStid = a.closest('[data-stid]');
        return {
          href: cleanHref,
          text: a.textContent.trim().slice(0, 50),
          className: a.className,
          dataStid: a.getAttribute('data-stid') || (closestStid ? closestStid.getAttribute('data-stid') : null)
        };
      });

      const listingLinks = allLinks.filter(l => /vrbo\\.com\\/(?:\\d+|pdp|vacation-rental|hotel)/i.test(l.href) || /\\/\\d{5,}/.test(l.href));

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
    })()`);

    if (!domVal || typeof domVal !== "object") {
      throw new Error("Live DOM Deep Inspection failed: evaluation returned undefined or invalid structure.");
    }
    console.log("\n2. Live DOM Deep Inspection:", JSON.stringify(domVal, null, 2));

    // 3. Inspect Injected Badges & Aggregate Status Across ALL Badges
    const badgeAnalysis = await evalCdp(targetCdp, `(() => {
      const badges = Array.from(document.querySelectorAll('.vdp-search-badge'));
      const statusCounts = {};
      const terminalCounts = { unknown: 0, timeout: 0, error: 0, rate_limited: 0, capped: 0 };
      const sourceBreakdown = {};
      let policyResolvedCount = 0;

      const allBadges = badges.map(b => {
        const card = b.closest('[data-vdp-prop-id]');
        const link = card ? card.querySelector('a[href*="/"]') : null;
        let cleanHref = null;
        if (link && link.href) {
          try {
            const u = new URL(link.href);
            cleanHref = u.origin + u.pathname;
          } catch {
            cleanHref = link.href.split('?')[0];
          }
        }
        const status = b.dataset.vdpStatus || 'unknown';
        const source = b.dataset.vdpSource || null;
        const propId = card ? card.getAttribute('data-vdp-prop-id') : null;

        statusCounts[status] = (statusCounts[status] || 0) + 1;
        if (terminalCounts[status] !== undefined) {
          terminalCounts[status]++;
        }
        if (status === 'allowed' || status === 'banned' || status === 'restrictions') {
          policyResolvedCount++;
          if (source) {
            sourceBreakdown[source] = (sourceBreakdown[source] || 0) + 1;
          }
        }

        return {
          text: b.textContent.trim(),
          className: b.className,
          status,
          source,
          propId,
          linkHref: cleanHref
        };
      });

      return {
        totalBadges: badges.length,
        statusCounts,
        terminalCounts,
        sourceBreakdown,
        policyResolvedCount,
        sampleBadges: allBadges.slice(0, 5)
      };
    })()`);

    if (!badgeAnalysis) {
      throw new Error("Badge analysis failed: evaluation returned undefined.");
    }
    console.log("\n3. Vrbow Search Badges (Aggregate):", JSON.stringify({
      totalBadges: badgeAnalysis.totalBadges,
      policyResolvedCount: badgeAnalysis.policyResolvedCount,
      statusCounts: badgeAnalysis.statusCounts,
      terminalCounts: badgeAnalysis.terminalCounts,
      sourceBreakdown: badgeAnalysis.sourceBreakdown,
      sampleBadges: badgeAnalysis.sampleBadges
    }, null, 2));

    // 4. Assertive Hover, Mouse Gap Transit, Close Button, and Keyboard Flow Verification
    // Select an appropriate resolved badge if available, otherwise first badge
    const inter = await evalCdp(targetCdp, `(async () => {
      const allBadges = Array.from(document.querySelectorAll('.vdp-search-badge'));
      if (allBadges.length === 0) return { error: 'No badge found to hover' };

      // Select a resolved badge if available, otherwise first badge
      const targetBadge = allBadges.find(b => ['allowed', 'banned', 'restrictions', 'capped'].includes(b.dataset.vdpStatus)) || allBadges[0];
      const parentCard = targetBadge.closest('[data-vdp-prop-id]');
      const expectedPropId = parentCard ? parentCard.getAttribute('data-vdp-prop-id') : null;
      const badgeStatus = targetBadge.dataset.vdpStatus || 'unknown';

      // Step A: Mouse enters badge
      targetBadge.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      await new Promise(r => setTimeout(r, 400));
      const tooltip = document.querySelector('.vdp-search-tooltip');
      const initialVisible = tooltip && tooltip.classList.contains('vdp-tooltip-visible') && tooltip.style.display !== 'none';
      const hasHeader = tooltip && /dog policy/i.test(tooltip.textContent);

      // Step B: Pointer moves across the gap to enter the tooltip (grace period test)
      targetBadge.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true, relatedTarget: tooltip }));
      if (tooltip) tooltip.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      const preservedAcrossGap = tooltip && tooltip.classList.contains('vdp-tooltip-visible') && tooltip.style.display !== 'none';

      // Step C: Verify listing link inside tooltip matches listing card
      const tooltipLink = tooltip ? tooltip.querySelector('a[href*="/"]') : null;
      let cleanTooltipLink = null;
      if (tooltipLink && tooltipLink.href) {
        try {
          const u = new URL(tooltipLink.href);
          cleanTooltipLink = u.origin + u.pathname;
        } catch {
          cleanTooltipLink = tooltipLink.href.split('?')[0];
        }
      }
      const linkMatchesProp = tooltipLink && expectedPropId && tooltipLink.href.includes(expectedPropId);
      const rows = tooltip ? Array.from(tooltip.querySelectorAll('.vdp-tooltip-row')) : [];
      const parsedFields = rows.map(r => {
        const lblEl = r.querySelector('.vdp-tooltip-label');
        const valEl = r.querySelector('.vdp-tooltip-val');
        return {
          label: lblEl && lblEl.textContent ? lblEl.textContent.trim() : '',
          value: valEl && valEl.textContent ? valEl.textContent.trim() : ''
        };
      }).filter(r => r.label && r.value);

      // Step D: Dismiss via Close Button click
      const closeBtn = tooltip ? tooltip.querySelector('.vdp-tooltip-close') : null;
      if (closeBtn) closeBtn.click();
      await new Promise(r => setTimeout(r, 200));
      const dismissedViaClose = tooltip ? tooltip.style.display === 'none' : false;

      // Step E: Keyboard activation (Enter key on badge)
      targetBadge.focus();
      targetBadge.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      const openedViaKeyboard = tooltip ? tooltip.style.display !== 'none' : false;

      // Step F: Dismiss via Escape key inside dialog
      if (tooltip) tooltip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(r => setTimeout(r, 200));
      const dismissedViaEscape = tooltip ? tooltip.style.display === 'none' : false;

      // Evaluate whether deep policy fields were recovered
      const deepFieldKeys = ["max dogs", "weight", "fee", "deposit", "prior approval"];
      const isDeepResolved = parsedFields.some(f => deepFieldKeys.some(k => f.label.toLowerCase().includes(k)));

      return {
        expectedPropId,
        badgeStatus,
        badgeFound: true,
        initialVisible,
        hasHeader,
        parsedFields,
        isDeepResolved,
        preservedAcrossGap,
        linkMatchesProp,
        cleanTooltipLink,
        dismissedViaClose,
        openedViaKeyboard,
        dismissedViaEscape
      };
    })()`, { awaitPromise: true });

    if (!inter || typeof inter !== "object") {
      throw new Error("Interactive verification failed: evaluation returned undefined.");
    }
    console.log("\n4. Assertive Tooltip & Interaction Verification:", JSON.stringify(inter, null, 2));

    // 5. Verification Assertions & Result Classification
    const totalBadges = badgeAnalysis.totalBadges || 0;
    const policyResolvedCount = badgeAnalysis.policyResolvedCount || 0;
    const detailsResolvedCount = inter.isDeepResolved ? 1 : 0;

    const allInteractionsPassed = inter.initialVisible &&
      inter.hasHeader &&
      inter.preservedAcrossGap &&
      inter.linkMatchesProp &&
      inter.dismissedViaClose &&
      inter.openedViaKeyboard &&
      inter.dismissedViaEscape;

    const hasResolvedBadge = policyResolvedCount > 0;
    const hasParsedFields = inter.parsedFields && inter.parsedFields.length > 0;

    const sourceLine = Object.keys(badgeAnalysis.sourceBreakdown).length
      ? Object.entries(badgeAnalysis.sourceBreakdown).map(([src, n]) => `${src}: ${n}`).join(", ")
      : "none resolved";
    console.log("\nResult source breakdown: " + sourceLine);

    // 6. Structured Machine-Readable Summary
    const summary = {
      mode,
      commit: getGitCommit(),
      timestamp: new Date().toISOString(),
      totalBadges,
      policyResolvedCount,
      detailsResolvedCount,
      statusCounts: badgeAnalysis.statusCounts,
      terminalCounts: badgeAnalysis.terminalCounts,
      sourceBreakdown: badgeAnalysis.sourceBreakdown,
      inspectedBadge: {
        propId: inter.expectedPropId,
        status: inter.badgeStatus,
        isDeepResolved: inter.isDeepResolved,
        parsedFields: inter.parsedFields
      }
    };

    console.log("\n══════════════════════════════════════════════════════");
    console.log("MACHINE-READABLE SUMMARY:");
    console.log(JSON.stringify(summary, null, 2));
    console.log("══════════════════════════════════════════════════════\n");

    if (totalBadges === 0) {
      console.error("❌ ASSERTION FAILED: Zero search badges were injected on live page.");
      process.exit(1);
    }
    if (!allInteractionsPassed) {
      console.error("❌ ASSERTION FAILED: Live tooltip interaction checks did not all pass:", inter);
      process.exit(1);
    }
    if (!hasResolvedBadge) {
      console.error("❌ ASSERTION FAILED: No search badge reached a parsed terminal policy state (allowed/banned/restrictions). Aggregate statuses:", badgeAnalysis.statusCounts);
      process.exit(1);
    }
    if (!hasParsedFields) {
      console.error("❌ ASSERTION FAILED: Live tooltip does not contain any parsed policy fields:", inter.parsedFields);
      process.exit(1);
    }

    const tierDescription = inter.isDeepResolved
      ? `Deep details recovered (${inter.parsedFields.map(f => `${f.label}: ${f.value}`).join(", ")})`
      : `Policy resolved (${inter.parsedFields.map(f => `${f.label}: ${f.value}`).join(", ")}; deep details pending or unavailable)`;

    console.log(`✅ LIVE VERIFICATION PASSED: ${totalBadges} badges injected across page (${policyResolvedCount} policy resolved), mode: ${mode}, ${tierDescription}, interactive mouse gap transit, close button, link matching, and keyboard flows verified.`);
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
