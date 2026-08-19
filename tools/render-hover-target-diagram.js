const { chromium } = require("@playwright/test");
const path = require("path");
const fs = require("fs");

async function renderHoverTarget() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 900, height: 580 },
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
      padding: 40px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f1f5f9;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
    }

    .card-wrap {
      position: relative;
    }

    .search-card {
      background: #ffffff;
      border-radius: 12px;
      border: 1px solid #e2e8f0;
      box-shadow: 0 4px 20px rgba(0,0,0,0.08);
      width: 480px;
      overflow: hidden;
    }

    .card-photo {
      height: 160px;
      background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 40px;
      color: white;
    }

    .card-content {
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .card-title {
      font-size: 16px;
      font-weight: 700;
      color: #0f172a;
    }

    .card-meta {
      font-size: 13px;
      color: #64748b;
    }

    .price-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid #f1f5f9;
    }

    .card-price {
      font-size: 18px;
      font-weight: 700;
      color: #0f172a;
    }

    .card-price span {
      font-size: 12px;
      font-weight: 400;
      color: #64748b;
    }

    /* Target Indicator Callout */
    .target-box {
      position: absolute;
      border: 3px dashed #ef4444;
      background: rgba(239, 68, 68, 0.08);
      border-radius: 8px;
      pointer-events: none;
      z-index: 100;
    }

    .callout-arrow {
      position: absolute;
      right: -240px;
      top: 250px;
      background: #0f172a;
      color: white;
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .callout-arrow::before {
      content: "";
      position: absolute;
      left: -8px;
      top: 50%;
      transform: translateY(-50%);
      border-width: 8px 8px 8px 0;
      border-style: solid;
      border-color: transparent #0f172a transparent transparent;
    }

    .mouse-pointer {
      position: absolute;
      width: 28px;
      height: 28px;
      background: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="%23ef4444"><path d="M4 0l16 12-7 1.5 4 8.5-3 1.5-4-8.5-6 5.5z" stroke="white" stroke-width="1.5"/></svg>') no-repeat;
      pointer-events: none;
      z-index: 200;
    }
  </style>
</head>
<body>
  <div class="card-wrap">
    <div class="search-card">
      <div class="card-photo">🏡</div>
      <div class="card-content">
        <div class="card-title">Lakeside Cabin with Private Dock & Fenced Yard</div>
        <div class="card-meta">3 beds · 2 baths · Sleeps 6 · 4.9 ★</div>
        <div class="price-row">
          <div class="card-price">$285 <span>/ night</span></div>
          <div class="vdp-search-badge vdp-badge-allowed" id="target-pill" tabindex="0">🐾 Max 2 dogs allowed · 50 lbs · $150/stay</div>
        </div>
      </div>
    </div>

    <div class="target-box" id="target-box"></div>
    <div class="callout-arrow" id="callout-label">
      👈 <strong>HOVER TARGET</strong><br><span style="font-size: 11.5px; font-weight: 400; color: #94a3b8;">Place mouse pointer right here on this pill</span>
    </div>
    <div class="mouse-pointer" id="pointer-icon"></div>
  </div>

  <script>
    const pill = document.getElementById("target-pill");
    const rect = pill.getBoundingClientRect();
    const wrapRect = document.querySelector(".card-wrap").getBoundingClientRect();

    const box = document.getElementById("target-box");
    box.style.left = (rect.left - wrapRect.left - 4) + "px";
    box.style.top = (rect.top - wrapRect.top - 4) + "px";
    box.style.width = (rect.width + 8) + "px";
    box.style.height = (rect.height + 8) + "px";

    const label = document.getElementById("callout-label");
    label.style.top = (rect.top - wrapRect.top - 10) + "px";
    label.style.left = (rect.right - wrapRect.left + 24) + "px";

    const pointer = document.getElementById("pointer-icon");
    pointer.style.left = (rect.left - wrapRect.left + rect.width / 2) + "px";
    pointer.style.top = (rect.top - wrapRect.top + rect.height / 2) + "px";
  </script>
</body>
</html>
`;

  await page.setContent(html);
  await page.waitForTimeout(200);

  const docsDir = path.join(__dirname, "../docs");
  const artifactDir = "/Users/rahul/.gemini/antigravity-ide/brain/abb52108-0cc7-439d-ab2e-5603fd21d294";

  const targetPathDocs = path.join(docsDir, "hover-target-callout.png");
  const targetPathArtifact = path.join(artifactDir, "hover-target-callout.png");

  await page.screenshot({ path: targetPathDocs });
  fs.copyFileSync(targetPathDocs, targetPathArtifact);
  console.log("Saved hover-target-callout.png");

  await browser.close();
}

renderHoverTarget().catch(console.error);
