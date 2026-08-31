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
    // 実機は WKWebView なので E2E だけ WebKit でも回す。VRT（toHaveScreenshot）は
    // ベースラインが darwin 1 セットしか無く engine 別に増やすと管理コストが増えるため対象外。
    // UT も DOM 挙動の比較が主目的でなく engine 差を検証する意義が薄いため chromium のみに残す。
    {
      name: "webkit",
      testMatch: /-e2e\.spec\.ts$/,
      use: { browserName: "webkit" },
    },
  ],
  webServer: {
    command: "npx serve src -l 3000 --no-clipboard",
    port: 3000,
    reuseExistingServer: !process.env.CI,
  },
});
