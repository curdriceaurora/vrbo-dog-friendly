const { chromium } = require("@playwright/test");
const path = require("path");
const fs = require("fs");

async function captureLiveSearchDemo() {
  const extensionPath = path.join(__dirname, "..");
  const context = await chromium.launchPersistentContext("", {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,960"
    ],
    viewport: { width: 1280, height: 960 }
  });

  const page = context.pages().length ? context.pages()[0] : await context.newPage();

  const testSearchUrl = "https://www.vrbo.com/Hotel-Search?destination=Lake+Tahoe%2C+California%2C+United+States+of+America&house_rules_group=pets_allowed";
  console.log(`Navigating to ${testSearchUrl}...`);
  await page.goto(testSearchUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(e => console.log("Navigation:", e.message));

  // Enable search enrichment in storage on this page context
  await page.evaluate(() => {
    if (globalThis.chrome?.storage?.local) {
      globalThis.chrome.storage.local.set({ searchEnrichment: true });
    }
  });

  console.log("Waiting for search badges to inject on real property cards...");
  try {
    await page.waitForSelector(".vdp-search-badge", { timeout: 20000 });
    console.log("Found .vdp-search-badge on live search results!");
  } catch (e) {
    console.log("Waiting for badges timed out:", e.message);
  }

  await page.waitForTimeout(6000);

  // Hover over the first badge using dispatchEvent / mouse.move
  const badgeInfo = await page.evaluate(() => {
    const b = document.querySelector(".vdp-search-badge");
    if (!b) return null;
    b.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    const rect = b.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: b.textContent };
  });

  console.log("Badge info:", badgeInfo);
  if (badgeInfo) {
    await page.mouse.move(badgeInfo.x, badgeInfo.y);
  }

  await page.waitForTimeout(2000);

  const screenshotPath = path.join(__dirname, "../docs/live-search-demo.png");
  const artifactDir = "/Users/rahul/.gemini/antigravity-ide/brain/abb52108-0cc7-439d-ab2e-5603fd21d294";
  const artifactPath = path.join(artifactDir, "live-search-demo.png");

  await page.screenshot({ path: screenshotPath, fullPage: false });
  fs.copyFileSync(screenshotPath, artifactPath);
  console.log(`Captured live search demo screenshot at ${screenshotPath}`);

  await context.close();
}

captureLiveSearchDemo().catch(console.error);
