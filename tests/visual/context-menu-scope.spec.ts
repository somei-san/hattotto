import { test, expect } from "./fixtures";

// リグレッションテスト: 右クリックメニューのイベントが全付箋に影響するバグ防止
// ctx-toggle-pin / ctx-zoom / ctx-apply-color は appWindow.listen() で登録し、
// グローバル listen() ではなくウィンドウスコープで受信すること。

test.describe("右クリックメニュー イベントスコープ", () => {
  const CONTEXT_MENU_EVENTS = ["ctx-toggle-pin", "ctx-zoom", "ctx-apply-color"];

  test("ctx-* イベントは appWindow.listen で登録されている", async ({ notePage }) => {
    const appWindowListeners = await notePage.evaluate(() =>
      Object.keys((window as any).__appWindowListeners),
    );
    for (const event of CONTEXT_MENU_EVENTS) {
      expect(appWindowListeners, `${event} が appWindow.listen に未登録`).toContain(event);
    }
  });

  test("ctx-* イベントはグローバル listen に登録されていない", async ({ notePage }) => {
    const globalListeners = await notePage.evaluate(() =>
      Object.keys((window as any).__globalListeners),
    );
    for (const event of CONTEXT_MENU_EVENTS) {
      expect(globalListeners, `${event} がグローバル listen に登録されている`).not.toContain(event);
    }
  });

  test("appWindow.listen 経由で ctx-apply-color を発火すると色が変わる", async ({ notePage }) => {
    await notePage.evaluate(() => {
      const listeners = (window as any).__appWindowListeners["ctx-apply-color"];
      if (listeners && listeners.length > 0) {
        listeners[0]({ payload: "blue" });
      }
    });

    // applyColor は CSS 変数 --bg を設定する
    const bg = await notePage.locator("#note").evaluate(
      (el) => el.style.getPropertyValue("--bg"),
    );
    expect(bg).toBe("var(--blue)");
  });

  test("appWindow.listen 経由で ctx-toggle-pin を発火するとピンが切り替わる", async ({ openNote }) => {
    const page = await openNote({ pinned: false }, { show_pin_button: true });

    const pinBtn = page.locator("#btn-pin");
    await expect(pinBtn).toBeVisible();
    await expect(pinBtn).not.toHaveClass(/active/);

    await page.evaluate(() => {
      const listeners = (window as any).__appWindowListeners["ctx-toggle-pin"];
      if (listeners && listeners.length > 0) {
        listeners[0]({});
      }
    });

    await expect(pinBtn).toHaveClass(/active/);
  });

  test("appWindow.listen 経由で ctx-zoom を発火するとズームが変わる", async ({ openNote }) => {
    const page = await openNote({ zoom: 100 });

    await page.evaluate(() => {
      const listeners = (window as any).__appWindowListeners["ctx-zoom"];
      if (listeners && listeners.length > 0) {
        listeners[0]({ payload: "in" });
      }
    });

    // changeZoom(+1) → 100 + 10 = 110 → style.zoom = 1.1
    const zoom = await page.locator("#note").evaluate(
      (el: HTMLElement) => el.style.zoom,
    );
    expect(zoom).toBe("1.1");
  });
});
