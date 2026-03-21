import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/visual",
  snapshotPathTemplate: `{testDir}/__screenshots__/${process.platform}/{testFilePath}/{arg}{ext}`,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: "http://localhost:3000",
    viewport: { width: 300, height: 350 },
    actionTimeout: 5000,
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  webServer: {
    command: "npx serve src -l 3000 --no-clipboard",
    port: 3000,
    reuseExistingServer: !process.env.CI,
  },
});
