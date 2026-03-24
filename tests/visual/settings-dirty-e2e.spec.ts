import { test, expect } from "./fixtures";

test.describe("設定画面の dirty チェック", () => {
  test("初期状態 → 保存ボタンが無効", async ({ openSettings }) => {
    const page = await openSettings();
    await expect(page.locator("#save-btn")).toBeDisabled();
  });

  test("カラー変更 → 保存ボタンが有効化", async ({ openSettings }) => {
    const page = await openSettings();
    await expect(page.locator("#save-btn")).toBeDisabled();

    // 別の色を選択
    await page.click('.color-dot[data-color="blue"]');
    await expect(page.locator("#save-btn")).toBeEnabled();
  });

  test("カラーを変更してから元に戻す → 保存ボタンが無効に戻る", async ({ openSettings }) => {
    const page = await openSettings();

    // blue に変更
    await page.click('.color-dot[data-color="blue"]');
    await expect(page.locator("#save-btn")).toBeEnabled();

    // yellow に戻す（デフォルト）
    await page.click('.color-dot[data-color="yellow"]');
    await expect(page.locator("#save-btn")).toBeDisabled();
  });

  test("透過度スライダー変更 → 保存ボタンが有効化", async ({ openSettings }) => {
    const page = await openSettings();
    await expect(page.locator("#save-btn")).toBeDisabled();

    // スライダーを操作
    await page.locator("#opacity-slider").fill("50");
    await expect(page.locator("#save-btn")).toBeEnabled();
  });

  test("トグル変更 → 保存ボタンが有効化", async ({ openSettings }) => {
    const page = await openSettings();
    await expect(page.locator("#save-btn")).toBeDisabled();

    // シングルクリック編集トグルを切り替え（input は display:none なので隣接する .toggle-track をクリック）
    await page.locator("#single-click-toggle + .toggle-track").click();
    await expect(page.locator("#save-btn")).toBeEnabled();
  });

  test("保存ボタンクリック → ウィンドウが閉じる（closeが呼ばれる）", async ({ openSettings }) => {
    const page = await openSettings();

    // 変更を加えて保存ボタンを有効化
    await page.click('.color-dot[data-color="green"]');
    await expect(page.locator("#save-btn")).toBeEnabled();

    // 保存
    await page.click("#save-btn");

    // close が呼ばれたことを確認
    await expect.poll(
      () => page.evaluate(() => (window as any).__closeWasCalled),
      { timeout: 3000 },
    ).toBe(true);
  });

  test("複数項目変更 → 1つだけ戻しても dirty のまま", async ({ openSettings }) => {
    const page = await openSettings();

    // 2つの変更を加える
    await page.click('.color-dot[data-color="pink"]');
    await page.locator("#opacity-slider").fill("60");
    await expect(page.locator("#save-btn")).toBeEnabled();

    // カラーだけ元に戻す
    await page.click('.color-dot[data-color="yellow"]');
    // opacity がまだ変更されているので dirty のまま
    await expect(page.locator("#save-btn")).toBeEnabled();
  });

  test("全項目を元に戻す → 保存ボタンが無効に戻る", async ({ openSettings }) => {
    const page = await openSettings();

    // 2つの変更
    await page.click('.color-dot[data-color="pink"]');
    await page.locator("#opacity-slider").fill("60");
    await expect(page.locator("#save-btn")).toBeEnabled();

    // 全部元に戻す
    await page.click('.color-dot[data-color="yellow"]');
    await page.locator("#opacity-slider").fill("100");
    await expect(page.locator("#save-btn")).toBeDisabled();
  });
});
