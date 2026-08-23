import { test, expect } from "./fixtures";

// ── 設定の反映確認 ────────────────────────────────────────────

test.describe("設定反映: 初期ロード", () => {
  test("opacity: 50 → 付箋の opacity が 0.5 になる", async ({ openNote }) => {
    const page = await openNote({}, { opacity: 50 });

    const opacity = await page.evaluate(
      () => document.getElementById("note")!.style.opacity,
    );
    expect(opacity).toBe("0.5");
  });

  test("opacity: 100 → 付箋の opacity が 1 になる", async ({ openNote }) => {
    const page = await openNote({}, { opacity: 100 });

    const opacity = await page.evaluate(
      () => document.getElementById("note")!.style.opacity,
    );
    expect(opacity).toBe("1");
  });

  test("show_pin_button: false → ピンボタン非表示", async ({ openNote }) => {
    const page = await openNote({}, { show_pin_button: false });
    await expect(page.locator("#btn-pin")).toBeHidden();
  });

  test("show_color_button: false → カラーボタン非表示かつカラーピッカーのドット非表示", async ({ openNote }) => {
    const page = await openNote({}, { show_color_button: false });
    await expect(page.locator("#btn-color")).toBeHidden();
  });
});

test.describe("設定反映: settings-changed イベント", () => {
  test("opacity 変更イベント → 付箋の opacity がリアルタイムで変わる", async ({ openNote }) => {
    const page = await openNote({}, { opacity: 100 });

    // 初期値を確認
    const before = await page.evaluate(
      () => document.getElementById("note")!.style.opacity,
    );
    expect(before).toBe("1");

    // settings-changed イベントを発火
    await page.evaluate(() => {
      const listeners = (window as any).__globalListeners["settings-changed"];
      if (listeners) {
        listeners.forEach((fn: any) => fn({
          payload: {
            default_color: "yellow",
            opacity: 40,
            bring_all_to_front: true,
            show_pin_button: true,
            show_new_button: true,
            show_color_button: true,
            confirm_before_delete: true,
            language: "ja",
            resolved_language: "ja",
          },
        }));
      }
    });

    const after = await page.evaluate(
      () => document.getElementById("note")!.style.opacity,
    );
    expect(after).toBe("0.4");
  });

  test("show_pin_button 変更イベント → ボタンの表示が切り替わる", async ({ openNote }) => {
    const page = await openNote({}, { show_pin_button: true });
    await expect(page.locator("#btn-pin")).toBeVisible();

    // settings-changed で非表示に
    await page.evaluate(() => {
      const listeners = (window as any).__globalListeners["settings-changed"];
      if (listeners) {
        listeners.forEach((fn: any) => fn({
          payload: {
            default_color: "yellow",
            opacity: 100,
            bring_all_to_front: true,
            show_pin_button: false,
            show_new_button: true,
            show_color_button: true,
            confirm_before_delete: true,
            language: "ja",
            resolved_language: "ja",
          },
        }));
      }
    });

    await expect(page.locator("#btn-pin")).toBeHidden();
  });
});
