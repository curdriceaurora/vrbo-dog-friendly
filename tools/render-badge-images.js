const { chromium } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

async function renderBadges() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: 3,
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

    body {
      margin: 0;
      padding: 40px;
      background: transparent;
      font-family: var(--vdp-font-family);
    }

    .badge-container {
      display: inline-block;
      padding: 4px;
    }
  </style>
</head>
<body>
  <div class="badge-container">
    <div class="vdp-search-badge vdp-badge-allowed" id="badge-limits" tabindex="0" role="button">🐾 Max 2 dogs allowed · 50 lbs · $150/stay</div>
  </div>
  <div class="badge-container">
    <div class="vdp-search-badge vdp-badge-allowed" id="badge-tiered" tabindex="0" role="button">🐾 Dogs allowed · 1st free · $25/add'l/stay</div>
  </div>
  <div class="badge-container">
    <div class="vdp-search-badge vdp-badge-banned" id="badge-banned" tabindex="0" role="button">🚫 Pets not allowed</div>
  </div>
</body>
</html>
`;

  await page.setContent(html);
  await page.waitForTimeout(200);

  const docsDir = path.join(__dirname, "../docs");
  const artifactDir = "/Users/rahul/.gemini/antigravity-ide/brain/abb52108-0cc7-439d-ab2e-5603fd21d294";

  const badges = [
    { id: "#badge-limits", filename: "badge-max-2-dogs.png" },
    { id: "#badge-tiered", filename: "badge-dogs-allowed-tiered.png" },
    { id: "#badge-banned", filename: "badge-pets-not-allowed.png" },
  ];

  for (const b of badges) {
    const el = page.locator(b.id);
    const outPathDocs = path.join(docsDir, b.filename);
    const outPathArtifact = path.join(artifactDir, b.filename);
    
    await el.screenshot({ path: outPathDocs, omitBackground: true });
    fs.copyFileSync(outPathDocs, outPathArtifact);
    console.log(`Saved ${b.filename}`);
  }

  // Also create a combined search card showcase
  const showcaseHtml = `
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
      padding: 24px;
      font-family: var(--vdp-font-family);
      background: #f8fafc;
      display: inline-flex;
      flex-direction: column;
      gap: 12px;
      border-radius: 12px;
    }
    .badge-row {
      display: flex;
      align-items: center;
      gap: 12px;
      background: #ffffff;
      padding: 10px 16px;
      border-radius: 8px;
      border: 1px solid #e2e8f0;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }
    .badge-label {
      font-size: 12px;
      font-weight: 600;
      color: #64748b;
      min-width: 140px;
    }
  </style>
</head>
<body>
  <div class="badge-row">
    <span class="badge-label">Limits & Flat Fee</span>
    <div class="vdp-search-badge vdp-badge-allowed">🐾 Max 2 dogs allowed · 50 lbs · $150/stay</div>
  </div>
  <div class="badge-row">
    <span class="badge-label">Tiered Fee Structure</span>
    <div class="vdp-search-badge vdp-badge-allowed">🐾 Dogs allowed · 1st free · $25/add'l/stay</div>
  </div>
  <div class="badge-row">
    <span class="badge-label">Pets Prohibited</span>
    <div class="vdp-search-badge vdp-badge-banned">🚫 Pets not allowed</div>
  </div>
</body>
</html>
`;

  await page.setContent(showcaseHtml);
  await page.waitForTimeout(200);
  const showcaseEl = page.locator("body");
  const showcaseDocs = path.join(docsDir, "search-badge-examples.png");
  const showcaseArtifact = path.join(artifactDir, "search-badge-examples.png");
  await showcaseEl.screenshot({ path: showcaseDocs });
  fs.copyFileSync(showcaseDocs, showcaseArtifact);
  console.log("Saved search-badge-examples.png");

  await browser.close();
}

renderBadges().catch(console.error);
