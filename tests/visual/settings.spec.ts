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

test("settings tab — autostart on", async ({ openSettings }) => {
  const page = await openSettings({}, true);
  await expect(page).toHaveScreenshot("settings-autostart-on.png");
});

test("settings tab — after save", async ({ settingsPage }) => {
  await settingsPage.click('[data-color="green"]');
  await settingsPage.click('[data-size="12"]');
  await settingsPage.click("#save-btn");
  await settingsPage.waitForSelector("#save-msg:not(:empty)");
  await expect(settingsPage).toHaveScreenshot("settings-after-save.png");
});

// ── ヘルプタブ ─────────────────────────────────────────────

test("help tab", async ({ settingsPage }) => {
  await settingsPage.click('[data-tab="help"]');
  await expect(settingsPage).toHaveScreenshot("settings-help.png");
});
