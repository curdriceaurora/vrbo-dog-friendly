const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { expect, test } = require("@playwright/test");

const FIXTURES = path.join(__dirname, "..", "test", "fixtures");
const TARGET_STYLESHEETS = new Set(["tokens.css", "content.css", "popup.css"]);

function mergeRanges(ranges) {
  const sorted = ranges.map(({ start, end }) => [start, end]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const current of sorted) {
    const previous = merged.at(-1);
    if (!previous || current[0] > previous[1]) merged.push(current);
    else previous[1] = Math.max(previous[1], current[1]);
  }
  return merged;
}

function uncoveredSource(text, ranges) {
  const gaps = [];
  let cursor = 0;
  for (const [start, end] of mergeRanges(ranges)) {
    if (start > cursor) gaps.push(text.slice(cursor, start));
    cursor = Math.max(cursor, end);
  }
  if (cursor < text.length) gaps.push(text.slice(cursor));

  return gaps.join("")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@media[^\{]+/g, "")
    .replace(/[\s{}]/g, "");
}

test("exercises 100% of production theme rules across both color schemes", async ({ browser }) => {
  const aggregate = new Map();

  for (const scheme of ["light", "dark"]) {
    for (const fixture of ["panel-theme.html", "popup-theme.html"]) {
      const context = await browser.newContext({ colorScheme: scheme });
      const page = await context.newPage();
      await page.coverage.startCSSCoverage({ resetOnNavigation: false });
      await page.goto(pathToFileURL(path.join(FIXTURES, fixture)).href);

      if (fixture.startsWith("panel")) {
        const button = page.locator("#vdp-panel button").first();
        await button.hover();
        await button.focus();
        await page.locator("#vdp-panel").evaluate((panel) => {
          panel.classList.add("vdp-collapsed");
          const header = panel.querySelector(".vdp-header");
          header.className = "vdp-header vdp-tone-bad";
          getComputedStyle(header).backgroundColor;
          header.className = "vdp-header vdp-tone-unknown";
          getComputedStyle(header).backgroundColor;
          header.className = "vdp-header vdp-tone-loading";
          getComputedStyle(header).backgroundColor;
          header.className = "vdp-header vdp-tone-capped";
          getComputedStyle(header).backgroundColor;
          const finalRow = document.createElement("div");
          finalRow.className = "vdp-row-wrap";
          panel.querySelector(".vdp-body").appendChild(finalRow);
          getComputedStyle(finalRow).borderBottomStyle;
        });
      } else {
        const button = page.locator("#rescan");
        await button.hover();
        await button.focus();
        await page.evaluate(() => {
          const finalRow = document.createElement("div");
          finalRow.className = "row";
          document.body.appendChild(finalRow);
          getComputedStyle(finalRow).borderBottomStyle;
        });
      }

      for (const entry of await page.coverage.stopCSSCoverage()) {
        const filename = path.basename(new URL(entry.url).pathname);
        if (!TARGET_STYLESHEETS.has(filename)) continue;
        const current = aggregate.get(filename) || { text: entry.text, ranges: [] };
        current.ranges.push(...entry.ranges);
        aggregate.set(filename, current);
      }
      await context.close();
    }
  }

  expect(new Set(aggregate.keys())).toEqual(TARGET_STYLESHEETS);
  for (const [filename, coverage] of aggregate) {
    expect(uncoveredSource(coverage.text, coverage.ranges), `${filename} contains an unexercised theme rule`).toBe("");
  }
});
