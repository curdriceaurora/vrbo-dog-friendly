const { chromium } = require("@playwright/test");
const path = require("path");
const fs = require("fs");

async function captureLiveDemo() {
  const extensionPath = path.join(__dirname, "..", "src");
  const context = await chromium.launchPersistentContext("", {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,900"
    ],
    viewport: { width: 1280, height: 900 }
  });

  const page = context.pages().length ? context.pages()[0] : await context.newPage();
  
  // Real live listing URL
  const testUrl = "https://www.vrbo.com/3550839";
  console.log(`Navigating to ${testUrl}...`);
  await page.goto(testUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(e => console.log("Navigation:", e.message));

  console.log("Waiting for Vrbow panel to mount on live page...");
  try {
    await page.waitForSelector("#vdp-panel", { timeout: 15000 });
    console.log("Found #vdp-panel on live listing!");
  } catch {
    console.log("Panel wait timed out, checking page state...");
  }

  await page.waitForTimeout(4000);

  const screenshotPath = path.join(__dirname, "../docs/live-listing-demo.png");
  const artifactDir = "/Users/rahul/.gemini/antigravity-ide/brain/abb52108-0cc7-439d-ab2e-5603fd21d294";
  const artifactPath = path.join(artifactDir, "live-listing-demo.png");

  await page.screenshot({ path: screenshotPath, fullPage: false });
  fs.copyFileSync(screenshotPath, artifactPath);
  console.log(`Captured live demo screenshot at ${screenshotPath}`);

  await context.close();
}

captureLiveDemo().catch(console.error);
