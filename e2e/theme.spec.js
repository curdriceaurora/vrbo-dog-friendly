const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { expect, test } = require("@playwright/test");

const fixtures = path.join(__dirname, "..", "test", "fixtures");
const fixtureUrl = (name) => pathToFileURL(path.join(fixtures, name)).href;

const EXPECTED_ROLES = [
  "allowed-surface",
  "allowed-text",
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
    allowed: "rgb(19, 115, 51)",
    capped: "rgb(103, 78, 167)",
    warning: "rgb(117, 75, 0)",
    prohibited: "rgb(179, 38, 30)",
    unknown: "rgb(95, 99, 104)",
    link: "rgb(11, 87, 208)",
    loading: "rgb(79, 85, 89)",
    focus: "rgb(0, 95, 204)",
    controlBorder: "rgb(115, 120, 124)"
  },
  dark: {
    surface: "rgb(32, 33, 36)",
    allowed: "rgb(129, 201, 149)",
    capped: "rgb(215, 185, 255)",
    warning: "rgb(253, 214, 99)",
    prohibited: "rgb(242, 139, 130)",
    unknown: "rgb(189, 193, 198)",
    link: "rgb(138, 180, 248)",
    loading: "rgb(210, 213, 216)",
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

      const hostStyle = await page.locator("#host-content").evaluate((element) => {
        const style = getComputedStyle(element);
        return { color: style.color, background: style.backgroundColor };
      });
      expect(hostStyle).toEqual({ color: "rgb(0, 0, 0)", background: "rgba(0, 0, 0, 0)" });

      const highlightedHostStyle = await page.locator(".vdp-highlight").evaluate((element) => {
        const style = getComputedStyle(element);
        return { color: style.color, colorScheme: style.colorScheme };
      });
      expect(highlightedHostStyle).toEqual({ color: "rgb(0, 0, 0)", colorScheme: "normal" });

      const close = page.getByRole("button", { name: "Close" });
      await close.focus();
      await expect(close).toHaveCSS("outline-color", colors.focus);

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
