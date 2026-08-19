#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "src");
const URL_1 = "https://www.vrbo.com/search?adults=2&children=&regionId=3000448572&destination=Elmont%2C+New+York%2C+United+States+of+America&latLong=40.700935%2C-73.712906&chkin=2026-10-17&chkout=2026-10-24&d1=2026-10-17&d2=2026-10-24&startDate=2026-10-17&endDate=2026-10-24&discounts_group=early_booking&house_rules_group=pets_allowed";
const URL_2 = "https://www.vrbo.com/search?chkin=2026-10-17&chkout=2026-10-24&privacyTrackingState=CAN_TRACK&productOffersId=369e2587-e81d-479f-a893-0532bd582b25&searchId=495a1ddc-2f0b-47d1-b32b-106531f52249&theme=&destination=Vilano+Beach%2C+St.+Augustine%2C+Florida%2C+United+States+of+America&regionId=602749&latLong=29.93858%2C-81.302017&startDate=2026-10-17&endDate=2026-10-24&adults=2&sort=RECOMMENDED&house_rules_group=pets_allowed";

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

async function inspectSearchUrl(ws, url, label) {
  console.log(`\n======================================================`);
  console.log(`INSPECTING: ${label}`);
  console.log(`URL: ${url.split("?")[0]}`);
  console.log(`======================================================`);

  // Navigate
  await evalCdp(ws, `window.location.href = ${JSON.stringify(url)};`);
  await sleep(6000);

  // Wait for property cards to be stamped with data-vdp-prop-id
  let mountedCount = 0;
  for (let attempt = 1; attempt <= 20; attempt++) {
    mountedCount = await evalCdp(ws, `document.querySelectorAll('[data-vdp-prop-id]').length`) || 0;
    if (mountedCount >= 5) break;
    await sleep(1000);
  }
  console.log(`Found ${mountedCount} stamped Vrbow property cards. Waiting 15s for queue...`);
  await sleep(15000);

  // Inspect first 5 cards
  const results = await evalCdp(ws, `(async () => {
    const cards = Array.from(document.querySelectorAll('[data-vdp-prop-id]')).slice(0, 5);
    const out = [];

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const propId = card.getAttribute('data-vdp-prop-id');
      const badge = card.querySelector('.vdp-search-badge');
      const link = card.querySelector('a[href*="/"]');
      let cleanUrl = null;
      if (link && link.href) {
        try {
          const u = new URL(link.href);
          cleanUrl = u.origin + u.pathname;
        } catch {
          cleanUrl = link.href.split('?')[0];
        }
      }

      // Hover badge to activate high-priority fetch & tooltip
      let tooltipRows = [];
      let tooltipNotes = [];
      if (badge) {
        badge.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));

        // Wait up to 4s for resolution if badge was loading
        for (let w = 0; w < 8; w++) {
          if (badge.dataset.vdpStatus && badge.dataset.vdpStatus !== 'loading') break;
          await new Promise(r => setTimeout(r, 500));
        }

        // Wait for async getCached to render tooltip DOM
        await new Promise(r => setTimeout(r, 600));

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
        await new Promise(r => setTimeout(r, 200));
      }

      out.push({
        index: i + 1,
        propId,
        url: cleanUrl,
        badgeText: badge ? badge.textContent.trim() : null,
        badgeClass: badge ? badge.className : null,
        badgeStatus: badge ? (badge.dataset.vdpStatus || 'unknown') : null,
        badgeSource: badge ? (badge.dataset.vdpSource || null) : null,
        tooltipRows,
        tooltipNotes
      });
    }
    return out;
  })()`);

  return results;
}

async function main() {
  const binary = findChrome();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vrbow-diag-"));
  const port = 9333;

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

    const res1 = await inspectSearchUrl(ws, URL_1, "URL 1: Elmont, NY");
    const res2 = await inspectSearchUrl(ws, URL_2, "URL 2: Vilano Beach, FL");

    console.log("\n======================================================");
    console.log("FINAL 5-LISTING BEHAVIOR REPORT");
    console.log("======================================================");
    console.log("\n--- URL 1: Elmont, NY ---");
    console.log(JSON.stringify(res1, null, 2));

    console.log("\n--- URL 2: Vilano Beach, FL ---");
    console.log(JSON.stringify(res2, null, 2));

    ws.close();
  } finally {
    try { chromeProc.kill("SIGTERM"); } catch {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
