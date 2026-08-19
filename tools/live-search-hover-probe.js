const { chromium } = require("@playwright/test");
const path = require("path");
const fs = require("fs");

async function runLiveSearchHover() {
  const extensionPath = path.join(__dirname, "..", "src");
  
  console.log("Launching browser with Vrbow extension...");
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

  const searchUrl = "https://www.vrbo.com/Hotel-Search?destination=Lake+Tahoe%2C+California%2C+United+States+of+America&house_rules_group=pets_allowed";
  console.log(`Navigating to: ${searchUrl}`);
  
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 40000 });
  } catch (e) {
    console.log("Navigation notice:", e.message);
  }

  // 1. Bot Challenge Check
  const pageState = await page.evaluate(() => {
    const text = (document.body?.innerText || "") + (document.title || "");
    const isBot = /bot or not|human side|are you a human|unusual traffic|access denied|captcha|verify you/i.test(text);
    return { title: document.title, isBot };
  });

  if (pageState.isBot) {
    console.log(`⚠️ BOT CHALLENGE DETECTED ("${pageState.title}"). Gracefully stopping.`);
    await context.close();
    process.exit(2);
  }

  // 2. Enable search badging setting
  await page.evaluate(() => {
    if (globalThis.chrome?.storage?.local) {
      globalThis.chrome.storage.local.set({ vrbow_enable_search_badging: true });
    }
  });

  // 3. Dismiss any open calendar / date-picker / modal overlays
  console.log("Checking for and dismissing any open calendar or dialog overlays...");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  // Click background or search title to ensure focus is off the date picker
  await page.evaluate(() => {
    // If date picker apply button is visible, click it
    const doneBtn = Array.from(document.querySelectorAll('button')).find(b => /^(done|apply|select dates)/i.test(b.textContent.trim()));
    if (doneBtn) doneBtn.click();
  });
  await page.waitForTimeout(1000);

  // 4. Wait for search cards and injected badges
  console.log("Waiting for .vdp-search-badge to appear on search cards...");
  let badgeFound = false;
  try {
    await page.waitForSelector(".vdp-search-badge", { timeout: 25000 });
    badgeFound = true;
    console.log("Found .vdp-search-badge on live page!");
  } catch {
    console.log("Search badge not yet detected, checking DOM...");
  }

  if (!badgeFound) {
    const checkState = await page.evaluate(() => {
      return {
        cards: document.querySelectorAll('[data-stid="property-card"], [data-stid="lodging-card-responsive"]').length,
        badges: document.querySelectorAll('.vdp-search-badge').length,
        title: document.title
      };
    });
    console.log("Page state:", checkState);
    if (checkState.badges === 0) {
      console.log("No badges injected on this search page view. Stopping gracefully.");
      await context.close();
      return;
    }
  }

  // Allow queue to populate policy text
  await page.waitForTimeout(4000);

  // 5. Select the first search card, scroll it into view, and find the badge
  const badgeLocator = page.locator(".vdp-search-badge").first();
  await badgeLocator.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1000);

  const box = await badgeLocator.boundingBox();
  if (!box) {
    console.log("Badge has no bounding box. Stopping gracefully.");
    await context.close();
    return;
  }

  console.log(`Badge bounding box: x=${Math.round(box.x)}, y=${Math.round(box.y)}, w=${Math.round(box.width)}, h=${Math.round(box.height)}`);

  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;

  // 6. Hit-Testing Check at the exact center coordinate
  const hitTest = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    const stack = document.elementsFromPoint(x, y).map(e => `${e.tagName}${e.className ? '.' + e.className.replace(/\\s+/g, '.') : ''}`);
    const badge = document.querySelector(".vdp-search-badge");
    return {
      topElement: `${el?.tagName}.${el?.className}`,
      isBadge: badge ? (badge.contains(el) || el === badge) : false,
      stack: stack.slice(0, 5)
    };
  }, { x: centerX, y: centerY });

  console.log("Hit-Testing Diagnosis:", JSON.stringify(hitTest, null, 2));

  // 7. Physical Mouse Movement onto the Badge
  console.log(`Moving physical mouse cursor to (${Math.round(centerX)}, ${Math.round(centerY)})...`);
  // Move mouse in steps towards the badge
  await page.mouse.move(centerX - 100, centerY - 100);
  await page.waitForTimeout(200);
  await page.mouse.move(centerX, centerY);
  await page.waitForTimeout(2500);

  // 8. Check if Tooltip Dialog is rendered and visible
  const tooltipState = await page.evaluate(() => {
    const tip = document.getElementById("vdp-search-tooltip");
    if (!tip) return { exists: false };
    const rect = tip.getBoundingClientRect();
    const style = window.getComputedStyle(tip);
    return {
      exists: true,
      display: style.display,
      opacity: style.opacity,
      visibleClass: tip.classList.contains("vdp-tooltip-visible"),
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      text: tip.innerText
    };
  });

  console.log("Tooltip State on Mouse Hover:", JSON.stringify(tooltipState, null, 2));

  // 9. Capture live screenshot
  const screenshotPath = path.join(__dirname, "../docs/live-search-hover.png");
  const artifactDir = "/Users/rahul/.gemini/antigravity-ide/brain/abb52108-0cc7-439d-ab2e-5603fd21d294";
  const artifactPath = path.join(artifactDir, "live-search-hover.png");

  await page.screenshot({ path: screenshotPath });
  fs.copyFileSync(screenshotPath, artifactPath);
  console.log(`Screenshot saved to ${screenshotPath}`);

  await context.close();
}

runLiveSearchHover().catch((err) => {
  console.error("Live search hover run failed:", err.message);
  process.exit(1);
});
