const { chromium } = require("@playwright/test");
const path = require("path");

async function testHitTesting() {
  const extensionPath = path.join(__dirname, "..", "src");
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

  // Set the exact storage key used by content.js
  await page.evaluate(() => {
    if (globalThis.chrome?.storage?.local) {
      globalThis.chrome.storage.local.set({ vrbow_enable_search_badging: true, searchEnrichment: true });
    }
  });

  console.log("Waiting for .vdp-search-badge on live search page...");
  try {
    await page.waitForSelector(".vdp-search-badge", { timeout: 25000 });
    console.log("Found .vdp-search-badge!");
  } catch (e) {
    console.log("Wait timeout:", e.message);
  }

  await page.waitForTimeout(4000);

  const hitTest = await page.evaluate(() => {
    const b = document.querySelector(".vdp-search-badge");
    if (!b) return { error: "No badge found on page" };
    const rect = b.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const topEl = document.elementFromPoint(x, y);
    const allEls = document.elementsFromPoint(x, y).map(el => ({
      tag: el.tagName,
      className: el.className,
      id: el.id,
      role: el.getAttribute("role"),
      dataStid: el.getAttribute("data-stid")
    }));

    return {
      x, y,
      badgeText: b.textContent,
      topElement: {
        tag: topEl?.tagName,
        className: topEl?.className,
        id: topEl?.id,
        isBadgeOrChild: b.contains(topEl) || topEl === b
      },
      stack: allEls.slice(0, 10)
    };
  });

  console.log("Hit-Testing Diagnosis Results:", JSON.stringify(hitTest, null, 2));

  await context.close();
}

testHitTesting().catch(console.error);
