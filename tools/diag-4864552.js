const { spawn, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = process.cwd();
const SEARCH_URL = "https://www.vrbo.com/search?chkin=2026-10-17&chkout=2026-10-24&privacyTrackingState=CAN_TRACK&productOffersId=369e2587-e81d-479f-a893-0532bd582b25&searchId=495a1ddc-2f0b-47d1-b32b-106531f52249&theme=&latLong=29.80909%2C-81.26101&mapBounds=29.80271%2C-81.26568&mapBounds=29.81547%2C-81.25634&startDate=2026-10-17&endDate=2026-10-24&adults=2&sort=RECOMMENDED&house_rules_group=pets_allowed&previousRegionId=553248621560560281";
const LISTING_URL = "https://www.vrbo.com/4864552";

function findChrome() {
  const puppeteerDir = path.join(os.homedir(), ".cache/puppeteer/chrome");
  if (fs.existsSync(puppeteerDir)) {
    try {
      const output = execSync(`find "${puppeteerDir}" -type f -name "Google Chrome for Testing" 2>/dev/null`, { encoding: "utf8" });
      const lines = output.trim().split("\n").filter(Boolean);
      if (lines.length > 0) return lines[0];
    } catch {}
  }
  return "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function evalCdp(ws, expression) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 100000);
    const handler = (evt) => {
      const msg = JSON.parse(evt.data.toString());
      if (msg.id === id) {
        ws.removeEventListener("message", handler);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else if (msg.result && msg.result.exceptionDetails) reject(new Error(JSON.stringify(msg.result.exceptionDetails)));
        else resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
      }
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
  });
}

(async () => {
  const binary = findChrome();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vrbow-diag-4864552-"));
  const port = 9666;
  const proc = spawn(binary, [
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
    const pagesRes = await fetch(`http://127.0.0.1:${port}/json/list`);
    const pages = await pagesRes.json();
    const page = pages.find(p => p.type === "page") || pages[0];
    const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => ws.onopen = r);

    // 1. Inspect on search page
    console.log("Navigating to Search URL...");
    await evalCdp(ws, `window.location.href = ${JSON.stringify(SEARCH_URL)};`);
    await sleep(8000);

    const searchInspection = await evalCdp(ws, `(async () => {
      const card = document.querySelector('[data-vdp-prop-id="4864552"]');
      if (!card) {
        return { found: false, allMounted: Array.from(document.querySelectorAll('[data-vdp-prop-id]')).map(c => c.getAttribute('data-vdp-prop-id')) };
      }
      const badge = card.querySelector('.vdp-search-badge');
      const badgeText = badge ? badge.textContent.trim() : null;
      const badgeStatus = badge ? badge.dataset.vdpStatus : null;
      const badgeSource = badge ? badge.dataset.vdpSource : null;

      // Read Apollo cache on search page for this property
      let apolloRecord = null;
      if (window.__APOLLO_STATE__) {
        for (const k in window.__APOLLO_STATE__) {
          if (k.includes('4864552') || JSON.stringify(window.__APOLLO_STATE__[k]).includes('4864552')) {
            apolloRecord = { key: k, val: window.__APOLLO_STATE__[k] };
            break;
          }
        }
      }

      return {
        found: true,
        badgeText,
        badgeStatus,
        badgeSource,
        apolloRecord
      };
    })()`);

    console.log("\nSearch Page Inspection for 4864552:");
    console.log(JSON.stringify(searchInspection, null, 2));

    // 2. Inspect on listing page
    console.log("\nNavigating directly to Listing 4864552...");
    await evalCdp(ws, `window.location.href = ${JSON.stringify(LISTING_URL)};`);
    await sleep(8000);

    const listingInspection = await evalCdp(ws, `(() => {
      const panel = document.querySelector('#vdp-panel');
      const panelText = panel ? panel.textContent.trim() : null;
      
      // Look for pet rules in Apollo on listing page
      let petRulesApollo = [];
      if (window.__APOLLO_STATE__) {
        for (const [k, v] of Object.entries(window.__APOLLO_STATE__)) {
          const str = JSON.stringify(v);
          if (/dog|pet|house rule/i.test(str)) {
            petRulesApollo.push({ key: k, data: v });
          }
        }
      }

      return {
        panelVisible: Boolean(panel),
        panelText,
        petRulesApollo: petRulesApollo.slice(0, 5)
      };
    })()`);

    console.log("\nListing Page Inspection for 4864552:");
    console.log(JSON.stringify(listingInspection, null, 2));

    ws.close();
  } finally {
    try { proc.kill("SIGTERM"); } catch {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
})();
