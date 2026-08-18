const { chromium } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 800, height: 480 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  const tokensCss = fs.readFileSync(path.join(__dirname, "../tokens.css"), "utf8");
  const contentCss = fs.readFileSync(path.join(__dirname, "../content.css"), "utf8");

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
      padding: 24px 32px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f7f9fa;
      color: #1a1e21;
    }
    .search-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid #e0e4e7;
    }
    .search-title {
      font-size: 18px;
      font-weight: 700;
      color: #1a1e21;
    }
    .search-subtitle {
      font-size: 13px;
      color: #5d676f;
      margin-top: 2px;
    }
    .card-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    .search-card {
      background: #fff;
      border-radius: 12px;
      border: 1px solid #e0e4e7;
      overflow: hidden;
      box-shadow: 0 2px 8px rgba(0,0,0,0.04);
      display: flex;
      flex-direction: column;
    }
    .card-img-wrap {
      height: 140px;
      background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%);
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      color: rgba(255,255,255,0.8);
      font-size: 32px;
    }
    .card-img-wrap.card2 {
      background: linear-gradient(135deg, #065f46 0%, #10b981 100%);
    }
    .card-content {
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .card-headline {
      font-size: 15px;
      font-weight: 600;
      color: #1a1e21;
      line-height: 1.3;
    }
    .card-meta {
      font-size: 13px;
      color: #64748b;
    }
    .card-price-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      margin-top: 4px;
    }
    .card-price {
      font-size: 16px;
      font-weight: 700;
      color: #0f172a;
    }
    .card-price span {
      font-size: 12px;
      font-weight: 400;
      color: #64748b;
    }
    #cursor {
      position: fixed;
      width: 18px;
      height: 18px;
      background: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="black"><path d="M4 0l16 12-7 1.5 4 8.5-3 1.5-4-8.5-6 5.5z" stroke="white" stroke-width="1.5"/></svg>') no-repeat;
      pointer-events: none;
      z-index: 999999;
      transform: translate(-2px, -2px);
      transition: transform 0.08s linear;
    }
  </style>
</head>
<body>
  <div class="search-header">
    <div>
      <div class="search-title">Lake Tahoe Vacation Rentals</div>
      <div class="search-subtitle">Over 450 pet-friendly homes available</div>
    </div>
  </div>

  <div class="card-grid">
    <!-- Card 1 -->
    <div class="search-card" id="card-1">
      <div class="card-img-wrap">🏡</div>
      <div class="card-content">
        <div class="card-headline">Cozy Mountain Chalet with Fenced Yard</div>
        <div class="card-meta">3 beds · 2 baths · Sleeps 6 · 4.9 ★</div>
        <div class="card-price-row">
          <div class="card-price">$245 <span>/ night</span></div>
          <div class="vdp-search-badge vdp-badge-loading" id="badge-1" tabindex="0" role="button">⏳ Checking pet policy...</div>
        </div>
      </div>
    </div>

    <!-- Card 2 -->
    <div class="search-card" id="card-2">
      <div class="card-img-wrap card2">🌲</div>
      <div class="card-content">
        <div class="card-headline">Lakefront Retreat with Private Beach</div>
        <div class="card-meta">4 beds · 3 baths · Sleeps 8 · 4.85 ★</div>
        <div class="card-price-row">
          <div class="card-price">$380 <span>/ night</span></div>
          <div class="vdp-search-badge vdp-badge-loading" id="badge-2" tabindex="0" role="button">⏳ Checking pet policy...</div>
        </div>
      </div>
    </div>
  </div>

  <!-- Tooltip Dialog Mock -->
  <div id="vdp-search-tooltip" class="vdp-search-tooltip" role="dialog" style="display: none; position: absolute; z-index: 10000;">
    <div class="vdp-tooltip-header vdp-tone-good">
      <span>🐾 Dog Policy</span>
    </div>
    <div class="vdp-tooltip-body">
      <div class="vdp-tooltip-row">
        <span class="vdp-tooltip-label">Status</span>
        <span class="vdp-tooltip-value vdp-tone-good">Dogs allowed</span>
      </div>
      <div class="vdp-tooltip-row">
        <span class="vdp-tooltip-label">Max dogs</span>
        <span class="vdp-tooltip-value">2</span>
      </div>
      <div class="vdp-tooltip-row">
        <span class="vdp-tooltip-label">Weight limit</span>
        <span class="vdp-tooltip-value">50 lbs</span>
      </div>
      <div class="vdp-tooltip-row">
        <span class="vdp-tooltip-label">Pet fee</span>
        <span class="vdp-tooltip-value">$150 per stay</span>
      </div>
      <div class="vdp-tooltip-footer">
        <a href="#rules">View listing rules →</a>
      </div>
    </div>
  </div>

  <div id="cursor" style="left: 700px; top: 400px;"></div>
</body>
</html>
`;

  const framesDir = path.join(__dirname, "../scratch/gif_frames");
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

  // 1. Initial State: loading badges
  await snap(8);

  // 2. Resolve Card 1 and Card 2 badges after dwell
  await page.evaluate(() => {
    const b1 = document.getElementById("badge-1");
    b1.className = "vdp-search-badge vdp-badge-allowed";
    b1.textContent = "🐾 Max 2 dogs allowed · 50 lbs · $150/stay";

    const b2 = document.getElementById("badge-2");
    b2.className = "vdp-search-badge vdp-badge-allowed";
    b2.textContent = "🐾 Dogs allowed · 1st free · $25/add'l/stay";
  });
  await snap(10);

  // 3. Move cursor towards Badge 1
  const b1Box = await page.locator("#badge-1").boundingBox();
  const startX = 700, startY = 400;
  const targetX = b1Box.x + b1Box.width / 2;
  const targetY = b1Box.y + b1Box.height / 2;

  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    const curX = startX + (targetX - startX) * (i / steps);
    const curY = startY + (targetY - startY) * (i / steps);
    await page.evaluate(({ x, y }) => {
      const c = document.getElementById("cursor");
      c.style.left = `${x}px`;
      c.style.top = `${y}px`;
    }, { x: curX, y: curY });
    await snap(1);
  }

  // 4. Hover over Badge 1 and open Tooltip
  await page.evaluate(({ b1Box }) => {
    const tip = document.getElementById("vdp-search-tooltip");
    tip.style.display = "block";
    tip.style.left = `${b1Box.x - 10}px`;
    tip.style.top = `${b1Box.y - 210}px`;
  }, { b1Box });
  await snap(16);

  // 5. Move cursor down over the tooltip link
  const tipLinkBox = await page.locator("#vdp-search-tooltip a").boundingBox();
  const linkTargetX = tipLinkBox.x + tipLinkBox.width / 2;
  const linkTargetY = tipLinkBox.y + tipLinkBox.height / 2;

  for (let i = 1; i <= 6; i++) {
    const curX = targetX + (linkTargetX - targetX) * (i / 6);
    const curY = targetY + (linkTargetY - targetY) * (i / 6);
    await page.evaluate(({ x, y }) => {
      const c = document.getElementById("cursor");
      c.style.left = `${x}px`;
      c.style.top = `${y}px`;
    }, { x: curX, y: curY });
    await snap(1);
  }
  await snap(14);

  // 6. Move cursor away to dismiss tooltip
  for (let i = 1; i <= 8; i++) {
    const curX = linkTargetX + (startX - linkTargetX) * (i / 8);
    const curY = linkTargetY + (startY - linkTargetY) * (i / 8);
    if (i === 3) {
      await page.evaluate(() => {
        document.getElementById("vdp-search-tooltip").style.display = "none";
      });
    }
    await page.evaluate(({ x, y }) => {
      const c = document.getElementById("cursor");
      c.style.left = `${x}px`;
      c.style.top = `${y}px`;
    }, { x: curX, y: curY });
    await snap(1);
  }
  await snap(6);

  await browser.close();

  // Combine into optimized animated GIF with Pillow
  execSync(`python3 -c "
from PIL import Image
import glob, os

frames = sorted(glob.glob('${framesDir}/frame_*.png'))
imgs = [Image.open(f).convert('P', palette=Image.ADAPTIVE) for f in frames]

out_path = path = path = '${path.join(__dirname, "../docs/search-demo.gif")}'
imgs[0].save(
    out_path,
    save_all=True,
    append_images=imgs[1:],
    duration=90,
    loop=0,
    optimize=True
)
print(f'Saved {out_path}: {os.path.getsize(out_path):,} bytes')
"`);
}

run().catch(console.error);
