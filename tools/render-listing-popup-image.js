const { chromium } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

async function renderListingPopup() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: 3,
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

    body {
      margin: 0;
      padding: 40px;
      background: transparent;
      font-family: var(--vdp-font-family);
    }

    #vdp-panel {
      position: static;
      margin: 0 auto;
      box-shadow: 0 8px 24px rgba(0,0,0,0.12);
    }
  </style>
</head>
<body>
  <div id="vdp-panel" role="region" aria-label="Dog policy">
    <div class="vdp-header vdp-tone-good">
      <span class="vdp-title">🐾 Dog-friendly</span>
      <div class="vdp-header-btns">
        <button class="vdp-rescan" title="Rescan page" aria-label="Rescan page">↻</button>
        <button class="vdp-close" title="Close" aria-label="Close">×</button>
      </div>
    </div>
    <div class="vdp-body">
      <div class="vdp-row-wrap">
        <div class="vdp-row">
          <span class="vdp-label">Max dogs</span>
          <span class="vdp-val vdp-tone-good">2</span>
          <button class="vdp-jump">source</button>
        </div>
      </div>
      <div class="vdp-row-wrap">
        <div class="vdp-row">
          <span class="vdp-label">Weight limit</span>
          <span class="vdp-val">50 lbs</span>
          <button class="vdp-jump">source</button>
        </div>
      </div>
      <div class="vdp-row-wrap">
        <div class="vdp-row">
          <span class="vdp-label">Fee</span>
          <span class="vdp-val vdp-tone-warn">$150 per stay</span>
          <button class="vdp-jump">source</button>
        </div>
      </div>
      <div class="vdp-row-wrap">
        <div class="vdp-row">
          <span class="vdp-label">Prior approval</span>
          <span class="vdp-val vdp-tone-warn">Required</span>
          <button class="vdp-jump">source</button>
        </div>
      </div>
      <div class="vdp-other-toggle">Other pet notes (2) ▾</div>
      <div class="vdp-other-list" style="display: block;">
        <div class="vdp-other-item">"Must be leashed in all shared outdoor areas." <span class="vdp-other-source">— House Rules</span></div>
        <div class="vdp-other-item">"No dogs on upstairs furniture." <span class="vdp-other-source">— About this property</span></div>
      </div>
      <div class="vdp-source-badge">Source: listing data (incl. collapsed/lazy sections)</div>
    </div>
  </div>
</body>
</html>
`;

  await page.setContent(html);
  await page.waitForTimeout(200);

  const docsDir = path.join(__dirname, "../docs");
  const artifactDir = "/Users/rahul/.gemini/antigravity-ide/brain/abb52108-0cc7-439d-ab2e-5603fd21d294";

  const panelEl = page.locator("#vdp-panel");
  const outPathDocs = path.join(docsDir, "listing-summary-popup.png");
  const outPathArtifact = path.join(artifactDir, "listing-summary-popup.png");

  await panelEl.screenshot({ path: outPathDocs, omitBackground: true });
  fs.copyFileSync(outPathDocs, outPathArtifact);
  console.log("Saved listing-summary-popup.png");

  await browser.close();
}

renderListingPopup().catch(console.error);
