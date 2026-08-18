const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { expect, test } = require("@playwright/test");

const fixtures = path.join(__dirname, "..", "test", "fixtures");
const fixtureUrl = (name) => pathToFileURL(path.join(fixtures, name)).href;

const EXPECTED_ROLES = [
  "allowed-surface",
  "allowed-text",
  "badge-allowed",
  "badge-banned",
  "badge-capped",
  "badge-loading",
  "badge-restrictions",
  "badge-unknown",
  "capped-text",
  "highlight",
  "link",
  "loading-text",
  "prohibited-text",
  "unknown-text",
  "warning-surface",
  "warning-text"
];

const EXPECTED_COLORS = {
  light: {
    surface: "rgb(255, 255, 255)",
    text: "rgb(32, 33, 36)",
    allowed: "rgb(19, 115, 51)",
    allowedSurface: "rgb(230, 244, 234)",
    capped: "rgb(103, 78, 167)",
    cappedSurface: "rgb(240, 235, 250)",
    warning: "rgb(117, 75, 0)",
    warningSurface: "rgb(255, 244, 206)",
    prohibited: "rgb(179, 38, 30)",
    prohibitedSurface: "rgb(252, 232, 230)",
    unknown: "rgb(95, 99, 104)",
    unknownSurface: "rgb(241, 243, 244)",
    link: "rgb(11, 87, 208)",
    loading: "rgb(79, 85, 89)",
    loadingSurface: "rgb(238, 241, 242)",
    focus: "rgb(0, 95, 204)",
    controlBorder: "rgb(115, 120, 124)"
  },
  dark: {
    surface: "rgb(32, 33, 36)",
    text: "rgb(241, 243, 244)",
    allowed: "rgb(129, 201, 149)",
    allowedSurface: "rgb(23, 60, 37)",
    capped: "rgb(215, 185, 255)",
    cappedSurface: "rgb(59, 46, 82)",
    warning: "rgb(253, 214, 99)",
    warningSurface: "rgb(74, 53, 16)",
    prohibited: "rgb(242, 139, 130)",
    prohibitedSurface: "rgb(75, 32, 32)",
    unknown: "rgb(189, 193, 198)",
    unknownSurface: "rgb(53, 54, 58)",
    link: "rgb(138, 180, 248)",
    loading: "rgb(210, 213, 216)",
    loadingSurface: "rgb(48, 50, 54)",
    focus: "rgb(168, 199, 250)",
    controlBorder: "rgb(138, 143, 148)"
  }
};

for (const scheme of ["light", "dark"]) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });

    test("covers every listing-panel role and preserves host-page isolation", async ({ page }) => {
      await page.goto(fixtureUrl("panel-theme.html"));
      const panel = page.locator("#vdp-panel");
      await expect(panel).toBeVisible();

      const roles = await page.locator("[data-theme-role]").evaluateAll((elements) =>
        elements.map((element) => element.dataset.themeRole).sort()
      );
      expect(roles).toEqual(EXPECTED_ROLES);

      const colors = EXPECTED_COLORS[scheme];
      await expect(panel).toHaveCSS("background-color", colors.surface);
      await expect(page.locator('[data-theme-role="allowed-text"]')).toHaveCSS("color", colors.allowed);
      await expect(page.locator('[data-theme-role="warning-text"]')).toHaveCSS("color", colors.warning);
      await expect(page.locator('[data-theme-role="prohibited-text"]')).toHaveCSS("color", colors.prohibited);
      await expect(page.locator('[data-theme-role="unknown-text"]')).toHaveCSS("color", colors.unknown);
      await expect(page.locator('[data-theme-role="loading-text"]')).toHaveCSS("color", colors.loading);
      await expect(page.locator('[data-theme-role="capped-text"]')).toHaveCSS("color", colors.capped);
      await expect(page.locator('[data-theme-role="link"]')).toHaveCSS("color", colors.link);

      // Search badge variants
      await expect(page.locator('[data-theme-role="badge-allowed"]')).toHaveCSS("color", colors.allowed);
      await expect(page.locator('[data-theme-role="badge-allowed"]')).toHaveCSS("background-color", colors.allowedSurface);
      await expect(page.locator('[data-theme-role="badge-banned"]')).toHaveCSS("color", colors.prohibited);
      await expect(page.locator('[data-theme-role="badge-banned"]')).toHaveCSS("background-color", colors.prohibitedSurface);
      await expect(page.locator('[data-theme-role="badge-loading"]')).toHaveCSS("color", colors.loading);
      await expect(page.locator('[data-theme-role="badge-loading"]')).toHaveCSS("background-color", colors.loadingSurface);
      await expect(page.locator('[data-theme-role="badge-unknown"]')).toHaveCSS("color", colors.unknown);
      await expect(page.locator('[data-theme-role="badge-unknown"]')).toHaveCSS("background-color", colors.unknownSurface);
      await expect(page.locator('[data-theme-role="badge-capped"]')).toHaveCSS("color", colors.capped);
      await expect(page.locator('[data-theme-role="badge-capped"]')).toHaveCSS("background-color", colors.cappedSurface);
      await expect(page.locator('[data-theme-role="badge-restrictions"]')).toHaveCSS("color", colors.warning);
      await expect(page.locator('[data-theme-role="badge-restrictions"]')).toHaveCSS("background-color", colors.warningSurface);

      // Search tooltip
      const tooltip = page.locator("#vdp-search-tooltip");
      await expect(tooltip).toBeVisible();
      await expect(tooltip).toHaveCSS("background-color", colors.surface);
      await expect(tooltip).toHaveCSS("color", colors.text);
      await expect(tooltip.locator(".vdp-tooltip-notes.vdp-tone-warn")).toHaveCSS("color", colors.warning);
      await expect(tooltip.locator(".vdp-tooltip-notes.vdp-tone-warn")).toHaveCSS("background-color", colors.warningSurface);
      await expect(tooltip.locator(".vdp-tooltip-footer a")).toHaveCSS("color", colors.link);

      const hostStyle = await page.locator("#host-content").evaluate((element) => {
        const style = getComputedStyle(element);
        return { color: style.color, background: style.backgroundColor };
      });
      expect(hostStyle).toEqual({ color: "rgb(0, 0, 0)", background: "rgba(0, 0, 0, 0)" });

      const searchCardStyle = await page.locator(".search-card").evaluate((element) => {
        const style = getComputedStyle(element);
        return { color: style.color, background: style.backgroundColor };
      });
      expect(searchCardStyle).toEqual({ color: "rgb(0, 0, 0)", background: "rgba(0, 0, 0, 0)" });

      const docRootVar = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--vdp-color-surface"));
      expect(docRootVar.trim()).toBe("");

      const cardVar = await page.locator(".search-card").evaluate((el) => getComputedStyle(el).getPropertyValue("--vdp-color-surface"));
      expect(cardVar.trim()).toBe("");

      const hostContentVar = await page.locator("#host-content").evaluate((el) => getComputedStyle(el).getPropertyValue("--vdp-color-surface"));
      expect(hostContentVar.trim()).toBe("");

      const highlightedHostStyle = await page.locator(".vdp-highlight").evaluate((element) => {
        const style = getComputedStyle(element);
        return { color: style.color, colorScheme: style.colorScheme };
      });
      expect(highlightedHostStyle).toEqual({ color: "rgb(0, 0, 0)", colorScheme: "normal" });

      const close = page.getByRole("button", { name: "Close" }).first();
      await close.focus();
      await expect(close).toHaveCSS("outline-color", colors.focus);

      const tooltipClose = tooltip.locator(".vdp-tooltip-close");
      await tooltipClose.focus();
      await expect(tooltipClose).toHaveCSS("outline-color", colors.focus);

      const tooltipLink = tooltip.locator(".vdp-tooltip-footer a");
      await tooltipLink.focus();
      await expect(tooltipLink).toHaveCSS("outline-color", colors.focus);

      const badge = page.locator("#badge-allowed");
      await badge.focus();
      await expect(badge).toHaveCSS("outline-color", colors.focus);

      const viewport = page.viewportSize();
      const box = await panel.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    });

    test("themes every popup state and keyboard focus", async ({ page }) => {
      await page.goto(fixtureUrl("popup-theme.html"));
      const colors = EXPECTED_COLORS[scheme];
      const body = page.locator("body");

      await expect(body).toHaveCSS("background-color", colors.surface);
      await expect(page.locator('[data-theme-role="allowed-text"]')).toHaveCSS("color", colors.allowed);
      await expect(page.locator('[data-theme-role="warning-text"]')).toHaveCSS("color", colors.warning);
      await expect(page.locator('[data-theme-role="prohibited-text"]')).toHaveCSS("color", colors.prohibited);
      await expect(page.locator('[data-theme-role="unknown-text"]')).toHaveCSS("color", colors.unknown);
      await expect(page.locator('[data-theme-role="loading-state"]')).toHaveCSS("color", colors.loading);
      await expect(page.locator('[data-theme-role="capped-state"]')).toHaveCSS("color", colors.capped);
      await expect(page.locator('[data-theme-role="loading-state"]')).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(page.locator('[data-theme-role="capped-state"]')).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

      await expect(page.locator("html")).toHaveCSS("color-scheme", scheme);

      const rescan = page.getByRole("button", { name: "Rescan" });
      await rescan.focus();
      await expect(rescan).toHaveCSS("outline-color", colors.focus);
      await expect(rescan).toHaveCSS("border-color", colors.controlBorder);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    });
  });
}

test("updates search badges and tooltips dynamically on live prefers-color-scheme media switch", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(fixtureUrl("panel-theme.html"));

  const badge = page.locator("#badge-allowed");
  const tooltip = page.locator("#vdp-search-tooltip");

  await expect(badge).toHaveCSS("color", EXPECTED_COLORS.light.allowed);
  await expect(badge).toHaveCSS("background-color", EXPECTED_COLORS.light.allowedSurface);
  await expect(tooltip).toHaveCSS("background-color", EXPECTED_COLORS.light.surface);

  // Live switch to dark without reloading page
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(badge).toHaveCSS("color", EXPECTED_COLORS.dark.allowed);
  await expect(badge).toHaveCSS("background-color", EXPECTED_COLORS.dark.allowedSurface);
  await expect(tooltip).toHaveCSS("background-color", EXPECTED_COLORS.dark.surface);

  // Live switch back to light
  await page.emulateMedia({ colorScheme: "light" });
  await expect(badge).toHaveCSS("color", EXPECTED_COLORS.light.allowed);
  await expect(badge).toHaveCSS("background-color", EXPECTED_COLORS.light.allowedSurface);
  await expect(tooltip).toHaveCSS("background-color", EXPECTED_COLORS.light.surface);
});

test("8.2.5: supports forced-colors active mode with visible boundaries and operable focus controls", async ({ browser }) => {
  const context = await browser.newContext({ forcedColors: "active" });
  const page = await context.newPage();

  // 1. Listing Panel & Search Badges in Forced Colors
  await page.goto(fixtureUrl("panel-theme.html"));

  const panel = page.locator("#vdp-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toHaveCSS("border-style", "solid");

  const badge = page.locator("#badge-allowed");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveCSS("border-style", "solid");

  // Focus visible outline on badge
  await badge.focus();
  await expect(badge).toBeFocused();
  await expect(badge).toHaveCSS("outline-style", "solid");

  // Focus visible on button in panel
  const panelBtn = page.locator("#vdp-panel button").first();
  await panelBtn.focus();
  await expect(panelBtn).toHaveCSS("outline-style", "solid");

  // Tooltip in Forced Colors
  const tooltip = page.locator("#vdp-search-tooltip");
  await expect(tooltip).toHaveCSS("border-style", "solid");

  const closeBtn = page.locator(".vdp-tooltip-close");
  await closeBtn.focus();
  await expect(closeBtn).toHaveCSS("outline-style", "solid");

  const tooltipLink = page.locator(".vdp-tooltip-footer a");
  await tooltipLink.focus();
  await expect(tooltipLink).toHaveCSS("outline-style", "solid");
  await expect(tooltipLink).toHaveCSS("text-decoration-line", "underline");

  // 2. Popup in Forced Colors
  await page.goto(fixtureUrl("popup-theme.html"));
  const rescan = page.getByRole("button", { name: "Rescan" });
  await expect(rescan).toBeVisible();
  await expect(rescan).toHaveCSS("border-style", "solid");

  await rescan.focus();
  await expect(rescan).toHaveCSS("outline-style", "solid");

  await context.close();
});

