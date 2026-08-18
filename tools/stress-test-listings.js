#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const URL_1 = "https://www.vrbo.com/search?adults=2&children=&regionId=3000448572&destination=Elmont%2C+New+York%2C+United+States+of+America&latLong=40.700935%2C-73.712906&chkin=2026-10-17&chkout=2026-10-24&d1=2026-10-17&d2=2026-10-24&startDate=2026-10-17&endDate=2026-10-24&discounts_group=early_booking&house_rules_group=pets_allowed";
const URL_2 = "https://www.vrbo.com/search?chkin=2026-10-17&chkout=2026-10-24&privacyTrackingState=CAN_TRACK&productOffersId=369e2587-e81d-479f-a893-0532bd582b25&searchId=495a1ddc-2f0b-47d1-b32b-106531f52249&theme=&destination=Vilano+Beach%2C+St.+Augustine%2C+Florida%2C+United+States+of+America&regionId=602749&latLong=29.93858%2C-81.302017&startDate=2026-10-17&endDate=2026-10-24&adults=2&sort=RECOMMENDED&house_rules_group=pets_allowed";
const URL_3 = "https://www.vrbo.com/search?chkin=2026-10-17&chkout=2026-10-24&privacyTrackingState=CAN_TRACK&productOffersId=369e2587-e81d-479f-a893-0532bd582b25&searchId=495a1ddc-2f0b-47d1-b32b-106531f52249&theme=&latLong=29.80913%2C-81.26101&mapBounds=29.7145%2C-81.3296&mapBounds=29.90367%2C-81.19242&startDate=2026-10-17&endDate=2026-10-24&adults=2&sort=RECOMMENDED&house_rules_group=pets_allowed&previousRegionId=553248621560560281";

const TARGET_INDICES = [1, 3, 8, 21, 50]; // 1-based sequential indices (50 is max API pagination limit)

function findChrome() {
  const puppeteerDir = path.join(os.homedir(), ".cache/puppeteer/chrome");
  if (fs.existsSync(puppeteerDir)) {
    try {
      const output = execSync(`find "${puppeteerDir}" -type f -name "Google Chrome for Testing" 2>/dev/null`, { encoding: "utf8" });
      const lines = output.trim().split("\n").filter(Boolean);
      if (lines.length > 0) return lines[0];
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
  throw new Error("No Chrome binary found.");
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url) {
  const res = await fetch(url);
  return res.json();
}

async function evalCdp(ws, expression) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 100000);
    const handler = (evt) => {
      const msg = JSON.parse(evt.data.toString());
      if (msg.id === id) {
        ws.removeEventListener("message", handler);
        if (msg.error) {
          reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else if (msg.result && msg.result.exceptionDetails) {
          reject(new Error("CDP Exception: " + JSON.stringify(msg.result.exceptionDetails)));
        } else {
          resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
        }
      }
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify({
      id,
      method: "Runtime.evaluate",
      params: {
        expression,
        returnByValue: true,
        awaitPromise: true
      }
    }));
  });
}

async function inspectStressSearchUrl(ws, url, label) {
  console.log(`\n======================================================`);
  console.log(`STRESS TEST: ${label}`);
  console.log(`URL: ${url.split("?")[0]}`);
  console.log(`Target Sequential Listing Indices: [${TARGET_INDICES.join(", ")}]`);
  console.log(`======================================================`);

  // 1. Navigate to target URL
  await evalCdp(ws, `window.location.href = ${JSON.stringify(url)};`);
  await sleep(7000);

  // 2. Real-time realistic user session: Tap Zoom Out -> Immediately browse, scroll & hover
  console.log("Executing realistic user flow: Click Zoom Out -> Immediately scroll & hover target cards...");
  const sessionResult = await evalCdp(ws, `(async () => {
    const targetIndices = [1, 3, 8, 21, 50];
    const targetedResults = [];
    const t0 = performance.now();

    // 1. Tap Zoom out ONCE
    const zoomOutBtn = document.querySelector('button[aria-label="Zoom out"], button[title="Zoom out"], div.gm-style > div:nth-of-type(5) button:nth-of-type(2)');
    let zoomClicked = false;
    if (zoomOutBtn) {
      zoomOutBtn.click();
      zoomClicked = true;
    } else {
      const allMapBtns = Array.from(document.querySelectorAll('.gm-style button, button[aria-label*="zoom" i]'));
      if (allMapBtns.length >= 2) {
        allMapBtns[1].click();
        zoomClicked = true;
      }
    }

    // Realistic human reaction time: 300ms reaction time before first interaction
    await new Promise(r => setTimeout(r, 300));

    // Interleaved realistic scroll & hover loop
    for (const targetIdx of targetIndices) {
      const zeroIdx = targetIdx - 1;

      // Scroll progressively until the target card is mounted
      let cards = Array.from(document.querySelectorAll('[data-vdp-prop-id]'));
      let scrollAttempts = 0;
      while (cards.length < targetIdx && scrollAttempts < 15) {
        scrollAttempts++;
        window.scrollBy(0, window.innerHeight * 0.8);
        await new Promise(r => setTimeout(r, 350));
        const showMore = Array.from(document.querySelectorAll('button')).find(b => /show more|see more|load more/i.test(b.textContent));
        if (showMore) showMore.click();
        const prevCount = cards.length;
        cards = Array.from(document.querySelectorAll('[data-vdp-prop-id]'));
        if (cards.length === prevCount && scrollAttempts > 3) break;
      }

      const card = cards[zeroIdx];
      const elapsedSec = ((performance.now() - t0) / 1000).toFixed(2);

      if (!card) {
        targetedResults.push({
          targetIndex: targetIdx,
          found: false,
          elapsedSinceZoomSec: elapsedSec,
          note: "Index exceeds available cards on page (Total cards: " + cards.length + ")"
        });
        continue;
      }

      // Scroll target into view
      card.scrollIntoView({ behavior: 'instant', block: 'center' });
      await new Promise(r => setTimeout(r, 150));

      const propId = card.getAttribute('data-vdp-prop-id');
      const badge = card.querySelector('.vdp-search-badge');
      const link = card.querySelector('a[href*="/"]');
      let cleanUrl = link && link.href ? link.href.split('?')[0] : null;

      let tooltipRows = [];
      let tooltipNotes = [];

      if (badge) {
        badge.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));

        // Wait up to 4s for high-priority on-hover resolution
        for (let w = 0; w < 8; w++) {
          if (badge.dataset.vdpStatus && badge.dataset.vdpStatus !== 'loading') break;
          await new Promise(r => setTimeout(r, 300));
        }

        // Allow async tooltip DOM update to finish
        await new Promise(r => setTimeout(r, 300));

        const activeTooltip = document.querySelector('#vdp-search-tooltip');
        if (activeTooltip && activeTooltip.style.display !== 'none') {
          const rows = Array.from(activeTooltip.querySelectorAll('.vdp-tooltip-row'));
          tooltipRows = rows.map(r => {
            const lbl = r.querySelector('.vdp-tooltip-label');
            const val = r.querySelector('.vdp-tooltip-val');
            return {
              label: lbl ? lbl.textContent.trim() : '',
              value: val ? val.textContent.trim() : (r.textContent.trim())
            };
          });
          const notes = Array.from(activeTooltip.querySelectorAll('.vdp-tooltip-notes'));
          tooltipNotes = notes.map(n => n.textContent.trim());
        }

        badge.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
        await new Promise(r => setTimeout(r, 150));
      }

      targetedResults.push({
        targetIndex: targetIdx,
        actualPosition: zeroIdx + 1,
        propId,
        url: cleanUrl,
        elapsedSinceZoomSec: elapsedSec,
        badgeText: badge ? badge.textContent.trim() : null,
        badgeClass: badge ? badge.className : null,
        badgeStatus: badge ? (badge.dataset.vdpStatus || 'unknown') : null,
        badgeSource: badge ? (badge.dataset.vdpSource || null) : null,
        tooltipRows,
        tooltipNotes
      });
    }

    // Capture post-flow performance & memory metrics
    const memory = performance && performance.memory ? {
      usedJSHeapSizeMB: (performance.memory.usedJSHeapSize / (1024 * 1024)).toFixed(2),
      totalJSHeapSizeMB: (performance.memory.totalJSHeapSize / (1024 * 1024)).toFixed(2)
    } : {};

    const badges = Array.from(document.querySelectorAll('.vdp-search-badge'));
    const statusCounts = {};
    const sourceBreakdown = {};
    badges.forEach(b => {
      const status = b.dataset.vdpStatus || 'unknown';
      const source = b.dataset.vdpSource || 'unknown';
      statusCounts[status] = (statusCounts[status] || 0) + 1;
      sourceBreakdown[source] = (sourceBreakdown[source] || 0) + 1;
    });

    return {
      zoomClicked,
      performanceMetrics: {
        totalCards: badges.length,
        statusCounts,
        sourceBreakdown,
        memory
      },
      targetedResults
    };
  })()`);

  console.log("\nTargeted Results & Post-Flow Metrics:");
  console.log(JSON.stringify(sessionResult, null, 2));

  return sessionResult;
}

async function main() {
  const binary = findChrome();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vrbow-stress-"));
  const port = 9444;

  const chromeProc = spawn(binary, [
    `--remote-debugging-port=${port}`,
    `--load-extension=${ROOT}`,
    `--disable-extensions-except=${ROOT}`,
    `--user-data-dir=${userDataDir}`,
    `--no-first-run`,
    `--no-default-browser-check`,
    "about:blank"
  ], { stdio: "ignore" });

  try {
    await sleep(2000);
    const pages = await fetchJson(`http://127.0.0.1:${port}/json/list`);
    const page = pages.find((p) => p.type === "page") || pages[0];
    if (!page || !page.webSocketDebuggerUrl) throw new Error("No CDP page available");

    const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    const rep1 = await inspectStressSearchUrl(ws, URL_1, "URL 1: Elmont, NY (Large Volume Stress Test)");
    const rep2 = await inspectStressSearchUrl(ws, URL_2, "URL 2: Vilano Beach, FL (Large Volume Stress Test)");
    const rep3 = await inspectStressSearchUrl(ws, URL_3, "URL 3: St. Augustine Map Flow (Large Volume Stress Test)");

    console.log("\n======================================================");
    console.log("SUMMARY REPORT: LISTINGS 1, 3, 8, 21, 51");
    console.log("======================================================");

    console.log("\n--- URL 1: Elmont, NY ---");
    console.log(JSON.stringify(rep1, null, 2));

    console.log("\n--- URL 2: Vilano Beach, FL ---");
    console.log(JSON.stringify(rep2, null, 2));

    console.log("\n--- URL 3: St. Augustine Map Flow ---");
    console.log(JSON.stringify(rep3, null, 2));

    ws.close();
  } finally {
    try { chromeProc.kill("SIGTERM"); } catch {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch(err => {
  console.error("Fatal stress test error:", err);
  process.exit(1);
});
