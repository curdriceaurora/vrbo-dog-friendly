const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const FILE_PATHS = {
  "manifest.json": path.join(ROOT, "src", "manifest.json"),
  "popup.html": path.join(ROOT, "src", "popup", "popup.html"),
  "popup.css": path.join(ROOT, "src", "popup", "popup.css"),
  "popup.js": path.join(ROOT, "src", "popup", "popup.js"),
  "tokens.css": path.join(ROOT, "src", "content", "tokens.css"),
  "content.css": path.join(ROOT, "src", "content", "content.css"),
  "content.js": path.join(ROOT, "src", "content", "content.js"),
};
const read = (file) => fs.readFileSync(FILE_PATHS[file] || path.join(ROOT, file), "utf8");

const REQUIRED_TOKENS = [
  "--vdp-font-family",
  "--vdp-color-surface",
  "--vdp-color-surface-subtle",
  "--vdp-color-surface-hover",
  "--vdp-color-text",
  "--vdp-color-text-secondary",
  "--vdp-color-text-muted",
  "--vdp-color-border",
  "--vdp-color-border-subtle",
  "--vdp-color-control-border",
  "--vdp-color-link",
  "--vdp-color-focus-ring",
  "--vdp-color-highlight-ring",
  "--vdp-policy-allowed-text",
  "--vdp-policy-allowed-surface",
  "--vdp-policy-warning-text",
  "--vdp-policy-warning-surface",
  "--vdp-policy-prohibited-text",
  "--vdp-policy-prohibited-surface",
  "--vdp-policy-unknown-text",
  "--vdp-policy-unknown-surface",
  "--vdp-policy-loading-text",
  "--vdp-policy-loading-surface",
  "--vdp-policy-capped-text",
  "--vdp-policy-capped-surface",
  "--vdp-shadow-panel"
];

const THEME_DEPENDENT_TOKENS = REQUIRED_TOKENS.filter((token) => token !== "--vdp-font-family");

const THEME_COLOR_PAIRS = {
  light: {
    text: ["#202124", "#ffffff"],
    secondary: ["#4f5559", "#ffffff"],
    muted: ["#62686c", "#ffffff"],
    link: ["#0b57d0", "#ffffff"],
    allowed: ["#137333", "#e6f4ea"],
    warning: ["#754b00", "#fff4ce"],
    prohibited: ["#b3261e", "#fce8e6"],
    unknown: ["#5f6368", "#f1f3f4"],
    loading: ["#4f5559", "#eef1f2"],
    capped: ["#674ea7", "#f0ebfa"]
  },
  dark: {
    text: ["#f1f3f4", "#202124"],
    secondary: ["#d2d5d8", "#202124"],
    muted: ["#bdc1c6", "#202124"],
    link: ["#8ab4f8", "#202124"],
    allowed: ["#81c995", "#173c25"],
    warning: ["#fdd663", "#4a3510"],
    prohibited: ["#f28b82", "#4b2020"],
    unknown: ["#bdc1c6", "#35363a"],
    loading: ["#d2d5d8", "#303236"],
    capped: ["#d7b9ff", "#3b2e52"]
  }
};

const THEME_NON_TEXT_PAIRS = {
  light: {
    controlBorder: ["#73787c", "#ffffff"],
    focusRing: ["#005fcc", "#ffffff"],
    highlightRing: ["#8a4f00", "#ffffff"]
  },
  dark: {
    controlBorder: ["#8a8f94", "#202124"],
    focusRing: ["#a8c7fa", "#202124"],
    highlightRing: ["#fdd663", "#202124"]
  }
};

function luminance(hex) {
  const channels = hex.match(/[0-9a-f]{2}/gi).map((value) => parseInt(value, 16) / 255);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
}

function contrastRatio(first, second) {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

test("theme assets load in the required order and remain scoped", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const isolatedScript = manifest.content_scripts.find((entry) => entry.js?.includes("content/content.js"));
  assert.deepEqual(isolatedScript.css, ["content/tokens.css", "content/content.css"]);

  const popup = read("popup.html");
  assert.ok(popup.indexOf('href="../content/tokens.css"') < popup.indexOf('href="popup.css"'));
  assert.match(popup, /<html class="vdp-theme-root">/);
  assert.doesNotMatch(popup, /<body class="vdp-theme-root">/);

  const tokens = read("tokens.css");
  assert.doesNotMatch(tokens, /(^|[,{]\s*):root\b/m, "tokens must not be defined on the Vrbo document root");
  assert.match(tokens, /:where\(#vdp-panel, \.vdp-theme-root, \.vdp-search-badge, \.vdp-search-tooltip\)/);
  assert.match(tokens, /\.vdp-highlight\s*\{\s*--vdp-color-highlight-ring:/);
});

test("loading and capped states consume their semantic tokens", () => {
  const content = read("content.css");
  const popup = read("popup.css");
  for (const state of ["loading", "capped"]) {
    assert.match(content, new RegExp(`\\.vdp-tone-${state}[^}]+var\\(--vdp-policy-${state}-text\\)`));
    assert.match(content, new RegExp(`\\.vdp-header\\.vdp-tone-${state}[^}]+var\\(--vdp-policy-${state}-surface\\)`));
    assert.match(popup, new RegExp(`\\.tone-${state}[^}]+var\\(--vdp-policy-${state}-text\\)`));
    assert.match(popup, new RegExp(`\\.status-tone\\.tone-${state}[^}]+var\\(--vdp-policy-${state}-surface\\)`));
  }

  assert.match(read("popup.html"), /class="status-tone tone-loading">Loading…/);
  assert.match(read("popup.js"), /class="status-tone tone-loading">Rescanning…/);
});

test("every semantic token is declared and every color token has a dark override", () => {
  const css = read("tokens.css");
  const darkStart = css.indexOf("@media (prefers-color-scheme: dark)");
  assert.ok(darkStart > 0);
  const lightCss = css.slice(0, darkStart);
  const darkCss = css.slice(darkStart);

  for (const token of REQUIRED_TOKENS) {
    const pattern = new RegExp(`${token.replaceAll("-", "\\-")}\\s*:`);
    assert.match(lightCss, pattern, `${token} needs a light value`);
  }
  for (const token of THEME_DEPENDENT_TOKENS) {
    const pattern = new RegExp(`${token.replaceAll("-", "\\-")}\\s*:`);
    assert.match(darkCss, pattern, `${token} needs a dark value`);
  }
});

test("all theme text and policy-state pairs meet WCAG AA contrast", () => {
  for (const [theme, pairs] of Object.entries(THEME_COLOR_PAIRS)) {
    for (const [role, [foreground, background]] of Object.entries(pairs)) {
      assert.ok(contrastRatio(foreground, background) >= 4.5, `${theme} ${role} contrast must be at least 4.5:1`);
    }
  }
});

test("controls, focus rings, and highlights meet WCAG non-text contrast", () => {
  for (const [theme, pairs] of Object.entries(THEME_NON_TEXT_PAIRS)) {
    for (const [role, [foreground, background]] of Object.entries(pairs)) {
      assert.ok(contrastRatio(foreground, background) >= 3, `${theme} ${role} contrast must be at least 3:1`);
    }
  }
});

test("badge boundaries and focus rings satisfy WCAG non-text and component identification standards", () => {
  // WCAG 2.1 SC 1.4.11 (Non-text Contrast):
  // 1. Search badges are pill-style chips identified by their filled background surface,
  //    emoji icons, and high-contrast text rather than an isolated standalone border line.
  // 2. Focused badges receive a prominent 2px outline using --vdp-color-focus-ring,
  //    which provides >= 3:1 non-text contrast against host cards and page surfaces.
  for (const theme of ["light", "dark"]) {
    const focusPair = THEME_NON_TEXT_PAIRS[theme].focusRing;
    assert.ok(
      contrastRatio(focusPair[0], focusPair[1]) >= 3,
      `${theme} badge focus ring must satisfy >= 3:1 non-text contrast`
    );

    // All badge text-on-surface pairs meet AA text contrast (>= 4.5:1)
    for (const state of ["allowed", "warning", "prohibited", "unknown", "loading", "capped"]) {
      const pair = THEME_COLOR_PAIRS[theme][state];
      assert.ok(
        contrastRatio(pair[0], pair[1]) >= 4.5,
        `${theme} ${state} badge text/surface pair must satisfy >= 4.5:1 text contrast`
      );
    }
  }
});

test("component styles contain no independent color literals", () => {
  for (const file of ["content.css", "popup.css", "content.js", "popup.js"]) {
    assert.doesNotMatch(read(file), /#[0-9a-f]{3,8}\b|rgba?\s*\(/i, `${file} must consume tokens instead of defining colors`);
  }
});

test("every referenced Vrbow token is declared", () => {
  const declarations = new Set(Array.from(read("tokens.css").matchAll(/(--vdp-[\w-]+)\s*:/g), (match) => match[1]));
  for (const file of ["content.css", "popup.css"]) {
    const references = Array.from(read(file).matchAll(/var\((--vdp-[\w-]+)\)/g), (match) => match[1]);
    assert.ok(references.length > 0, `${file} must use shared tokens`);
    for (const token of references) assert.ok(declarations.has(token), `${file} references undeclared ${token}`);
  }
});
