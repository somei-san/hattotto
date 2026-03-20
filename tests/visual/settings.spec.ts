import { test, expect } from "./fixtures";

// ── 設定タブ ───────────────────────────────────────────────

test("settings tab — default (yellow, 14px)", async ({ settingsPage }) => {
  await expect(settingsPage).toHaveScreenshot("settings-default.png");
});

test("settings tab — blue selected", async ({ openSettings }) => {
  const page = await openSettings({ default_color: "blue" });
  await expect(page).toHaveScreenshot("settings-color-blue.png");
});

test("settings tab — large font selected", async ({ openSettings }) => {
  const page = await openSettings({ font_size: 18 });
  await expect(page).toHaveScreenshot("settings-font-large.png");
});

test("settings tab — zoom 150%", async ({ openSettings }) => {
  const page = await openSettings({ zoom: 150 });
  await expect(page).toHaveScreenshot("settings-zoom-150.png");
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
  await settingsPage.click('[data-size="12"]');
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

test("help tab", async ({ settingsPage }) => {
  await settingsPage.click('[data-tab="help"]');
  await expect(settingsPage).toHaveScreenshot("settings-help.png");
});
