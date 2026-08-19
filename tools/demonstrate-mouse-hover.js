const { chromium } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

async function demonstrateMouseHover() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 900, height: 560 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  const tokensCss = fs.readFileSync(path.join(__dirname, "../src/content/tokens.css"), "utf8");
  const contentCss = fs.readFileSync(path.join(__dirname, "../src/content/content.css"), "utf8");

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    ${tokensCss}
    ${contentCss}

    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 32px 40px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f8fafc;
      color: #0f172a;
    }
    .demo-header {
      margin-bottom: 24px;
      padding-bottom: 12px;
      border-bottom: 1px solid #e2e8f0;
    }
    .demo-title {
      font-size: 20px;
      font-weight: 700;
      color: #0f172a;
    }
    .demo-subtitle {
      font-size: 13.5px;
      color: #64748b;
      margin-top: 4px;
    }
    .search-card {
      background: #ffffff;
      border-radius: 12px;
      border: 1px solid #e2e8f0;
      box-shadow: 0 4px 12px rgba(0,0,0,0.06);
      width: 440px;
      overflow: hidden;
      margin-top: 220px; /* Leave ample room for tooltip above */
    }
    .card-photo {
      height: 140px;
      background: linear-gradient(135deg, #1e40af 0%, #3b82f6 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 38px;
      color: white;
    }
    .card-body {
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .card-headline {
      font-size: 16px;
      font-weight: 600;
      color: #0f172a;
    }
    .card-meta {
      font-size: 13px;
      color: #64748b;
    }
    .price-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 8px;
    }
    .card-price {
      font-size: 17px;
      font-weight: 700;
    }
    .card-price span {
      font-size: 12px;
      font-weight: 400;
      color: #64748b;
    }

    #visual-cursor {
      position: fixed;
      width: 22px;
      height: 22px;
      background: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="black"><path d="M4 0l16 12-7 1.5 4 8.5-3 1.5-4-8.5-6 5.5z" stroke="white" stroke-width="1.5"/></svg>') no-repeat;
      pointer-events: none;
      z-index: 2147483647;
      transform: translate(-2px, -2px);
    }
  </style>
</head>
<body>
  <div class="demo-header">
    <div class="demo-title">Vrbo Vacation Rentals · Lake Tahoe, CA</div>
    <div class="demo-subtitle">Interactive Dog Policy Tooltip Dialog on Search Card</div>
  </div>

  <div class="search-card" id="prop-card">
    <div class="card-photo">🏡</div>
    <div class="card-body">
      <div class="card-headline">Mountain Chalet with Large Fenced Yard</div>
      <div class="card-meta">3 bedrooms · 2 baths · Sleeps 6 · 4.92 ★</div>
      <div class="price-row">
        <div class="card-price">$265 <span>/ night</span></div>
        <div class="vdp-search-badge vdp-badge-allowed" id="target-badge" tabindex="0" role="button" aria-haspopup="dialog">🐾 Max 2 dogs allowed · 50 lbs · $150/stay</div>
      </div>
    </div>
  </div>

  <!-- Real production search tooltip markup matching content.js renderTooltipContent -->
  <div id="vdp-search-tooltip" class="vdp-search-tooltip" role="dialog" aria-label="Dog policy" style="display: none;">
    <div class="vdp-tooltip-header">
      <span>🐾 Dog policy</span>
      <button class="vdp-tooltip-close" aria-label="Close details">×</button>
    </div>
    <div class="vdp-tooltip-row">
      <span class="vdp-tooltip-label">Dogs allowed</span>
      <span class="vdp-tooltip-val vdp-tone-good">Yes</span>
    </div>
    <div class="vdp-tooltip-row">
      <span class="vdp-tooltip-label">Max dogs</span>
      <span class="vdp-tooltip-val">2</span>
    </div>
    <div class="vdp-tooltip-row">
      <span class="vdp-tooltip-label">Weight limit</span>
      <span class="vdp-tooltip-val">50 lbs</span>
    </div>
    <div class="vdp-tooltip-row">
      <span class="vdp-tooltip-label">Pet fee</span>
      <span class="vdp-tooltip-val vdp-tone-warn">$150 per stay</span>
    </div>
    <div class="vdp-tooltip-row">
      <span class="vdp-tooltip-label">Prior approval</span>
      <span class="vdp-tooltip-val vdp-tone-warn">Required</span>
    </div>
    <div class="vdp-tooltip-footer">
      <a href="https://www.vrbo.com/12345" target="_blank" rel="noopener noreferrer">Open listing for complete rules ↗</a>
    </div>
  </div>

  <div id="visual-cursor" style="left: 750px; top: 480px;"></div>

  <script>
    const badge = document.getElementById("target-badge");
    const tooltip = document.getElementById("vdp-search-tooltip");
    let hideTimer = null;

    badge.addEventListener("mouseenter", () => {
      clearTimeout(hideTimer);
      const rect = badge.getBoundingClientRect();
      tooltip.style.display = "block";
      tooltip.classList.add("vdp-tooltip-visible");
      tooltip.style.left = Math.round(rect.left - 10) + "px";
      tooltip.style.top = Math.round(rect.top - 230) + "px";
    });

    badge.addEventListener("mouseleave", (e) => {
      if (e.relatedTarget && tooltip.contains(e.relatedTarget)) return;
      hideTimer = setTimeout(() => {
        tooltip.classList.remove("vdp-tooltip-visible");
        tooltip.style.display = "none";
      }, 200);
    });

    tooltip.addEventListener("mouseenter", () => {
      clearTimeout(hideTimer);
    });

    tooltip.addEventListener("mouseleave", (e) => {
      if (e.relatedTarget && badge.contains(e.relatedTarget)) return;
      hideTimer = setTimeout(() => {
        tooltip.classList.remove("vdp-tooltip-visible");
        tooltip.style.display = "none";
      }, 200);
    });
  </script>
</body>
</html>
`;

  const framesDir = path.join(__dirname, "../scratch/hover_frames");
  if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir, { recursive: true });

  await page.setContent(html);
  await page.waitForTimeout(200);

  let frameIdx = 0;
  async function snap(count = 1) {
    for (let i = 0; i < count; i++) {
      const framePath = path.join(framesDir, `frame_${String(frameIdx++).padStart(4, "0")}.png`);
      await page.screenshot({ path: framePath, scale: "css" });
    }
  }

  // 1. Initial State: cursor parked away from the badge
  await snap(6);

  // 2. Move mouse smoothly towards the search badge
  const badgeBox = await page.locator("#target-badge").boundingBox();
  const startX = 750, startY = 480;
  const targetX = badgeBox.x + badgeBox.width / 2;
  const targetY = badgeBox.y + badgeBox.height / 2;

  const steps = 14;
  for (let i = 1; i <= steps; i++) {
    const curX = startX + (targetX - startX) * (i / steps);
    const curY = startY + (targetY - startY) * (i / steps);

    // Physical mouse move using Playwright
    await page.mouse.move(curX, curY);

    // Update visual cursor icon
    await page.evaluate(({ x, y }) => {
      const c = document.getElementById("visual-cursor");
      c.style.left = `${x}px`;
      c.style.top = `${y}px`;
    }, { x: curX, y: curY });

    await snap(1);
  }

  // 3. Dwell over badge with tooltip fully open & visible
  await snap(20);

  // Also capture a static snapshot of the open tooltip for direct inspection
  const docsDir = path.join(__dirname, "../docs");
  const artifactDir = "/Users/rahul/.gemini/antigravity-ide/brain/abb52108-0cc7-439d-ab2e-5603fd21d294";
  const staticTooltipDocs = path.join(docsDir, "search-tooltip-detail.png");
  const staticTooltipArtifact = path.join(artifactDir, "search-tooltip-detail.png");
  await page.locator("#vdp-search-tooltip").screenshot({ path: staticTooltipDocs });
  fs.copyFileSync(staticTooltipDocs, staticTooltipArtifact);

  // 4. Move mouse up into the tooltip dialog
  const linkBox = await page.locator("#vdp-search-tooltip a").boundingBox();
  const linkTargetX = linkBox.x + linkBox.width / 2;
  const linkTargetY = linkBox.y + linkBox.height / 2;

  for (let i = 1; i <= 8; i++) {
    const curX = targetX + (linkTargetX - targetX) * (i / 8);
    const curY = targetY + (linkTargetY - targetY) * (i / 8);
    await page.mouse.move(curX, curY);
    await page.evaluate(({ x, y }) => {
      const c = document.getElementById("visual-cursor");
      c.style.left = `${x}px`;
      c.style.top = `${y}px`;
    }, { x: curX, y: curY });
    await snap(1);
  }

  // 5. Dwell over link inside tooltip
  await snap(16);

  // 6. Move mouse away to dismiss
  for (let i = 1; i <= 10; i++) {
    const curX = linkTargetX + (startX - linkTargetX) * (i / 10);
    const curY = linkTargetY + (startY - linkTargetY) * (i / 10);
    await page.mouse.move(curX, curY);
    await page.evaluate(({ x, y }) => {
      const c = document.getElementById("visual-cursor");
      c.style.left = `${x}px`;
      c.style.top = `${y}px`;
    }, { x: curX, y: curY });
    await snap(1);
  }
  await snap(8);

  await browser.close();

  // Save GIF and copy to artifact
  const outPathDocs = path.join(__dirname, "../docs/mouse-hover-demo.gif");
  const outPathArtifact = path.join(artifactDir, "mouse-hover-demo.gif");

  execSync(`python3 -c "
from PIL import Image
import glob, os

frames = sorted(glob.glob('${framesDir}/frame_*.png'))
imgs = [Image.open(f).convert('P', palette=Image.ADAPTIVE) for f in frames]

imgs[0].save(
    '${outPathDocs}',
    save_all=True,
    append_images=imgs[1:],
    duration=80,
    loop=0,
    optimize=True
)
"`);

  fs.copyFileSync(outPathDocs, outPathArtifact);
  console.log(`Saved ${outPathDocs} and search-tooltip-detail.png`);
}

demonstrateMouseHover().catch(console.error);
