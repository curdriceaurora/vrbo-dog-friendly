const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  workers: 2,
  forbidOnly: true,
  retries: 0,
  reporter: "line",
  use: {
    browserName: "chromium",
    headless: true,
    viewport: { width: 960, height: 720 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  }
});
