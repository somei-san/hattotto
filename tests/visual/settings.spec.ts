import { test, expect } from "./fixtures";

// ── 設定タブ ───────────────────────────────────────────────

test("settings tab — default", async ({ settingsPage }) => {
  await expect(settingsPage).toHaveScreenshot("settings-default.png");
});

test("settings tab — blue selected", async ({ openSettings }) => {
  const page = await openSettings({ default_color: "blue" });
  await expect(page).toHaveScreenshot("settings-color-blue.png");
});

test("settings tab — opacity 50%", async ({ openSettings }) => {
  const page = await openSettings({ opacity: 50 });
  await expect(page).toHaveScreenshot("settings-opacity-50.png");
});

test("settings tab — autostart on", async ({ openSettings }) => {
  const page = await openSettings({}, true);
  await expect(page).toHaveScreenshot("settings-autostart-on.png");
});

test("settings tab — save closes window", async ({ settingsPage }) => {
  await settingsPage.click('[data-color="green"]');
  await settingsPage.click("#save-btn");
  const closeCalled = await settingsPage.evaluate(() => (window as any).__closeWasCalled);
  expect(closeCalled).toBe(true);
});

// ── 削除確認トグル ─────────────────────────────────────────

test("settings tab — confirm-delete-toggle exists", async ({ settingsPage }) => {
  await expect(settingsPage.locator("#confirm-delete-toggle")).toBeAttached();
});

test("settings tab — confirm-delete-toggle default is checked", async ({ settingsPage }) => {
  await expect(settingsPage.locator("#confirm-delete-toggle")).toBeChecked();
});

// ── ヘルプタブ ─────────────────────────────────────────────

// 英語表示で撮る。日本語のヘルプは `<code>` に日本語が入り、等幅フォントの
// CJK フォールバックがローカルと CI ランナーで揃わない。
test("help tab", async ({ openSettings }) => {
  const page = await openSettings({ language: "en" });
  await page.click('[data-tab="help"]');
  await expect(page).toHaveScreenshot("settings-help.png");
});

// ── 支援タブ ───────────────────────────────────────────────

test("support tab", async ({ settingsPage }) => {
  await settingsPage.click('[data-tab="support"]');
  await expect(settingsPage).toHaveScreenshot("settings-support.png");
});

test("support tab — button opens the support page", async ({ settingsPage }) => {
  await settingsPage.click('[data-tab="support"]');
  await settingsPage.click("#support-btn");
  const calls = await settingsPage.evaluate(() => (window as any).__shell_open_calls);
  expect(calls).toEqual(["https://buymeacoffee.com/somei"]);
});
