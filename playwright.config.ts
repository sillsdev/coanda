import { defineConfig, devices } from "@playwright/test";

// The spec starts its own `coanda serve` on a scratch copy of samples/, so there is no
// webServer here. It needs a built app: run `vp build` first (the e2e script does).
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    // The installed Google Chrome, so no Playwright browser download is needed.
    channel: "chrome",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
});
