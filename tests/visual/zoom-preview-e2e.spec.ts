import { test, expect, injectNoteMock } from "./fixtures";
import type { Browser, Page } from "@playwright/test";

/** 付箋の背景色に当たっている CSS 変数（note.js の applyColor が設定する）。 */
const noteBg = (page: Page) =>
  page.evaluate(() => document.getElementById("note")!.style.getPropertyValue("--bg"));

// ── 設定画面の「新しい付箋のズーム」のプレビュー ────────────────

/** プレビューとして note.html を開く（src-tauri/src/window.rs の show_zoom_preview と同じ URL）。 */
async function openPreview(browser: Browser, query: string) {
  const ctx = await browser.newContext({ viewport: { width: 280, height: 320 } });
  const page = await ctx.newPage();
  await injectNoteMock(page, {}, {}, { captureInvokes: true });
  // テスト用の serve は /note.html を /note へリダイレクトする際にクエリを落とすため、
  // リダイレクトされない /note を直接開く
  await page.goto(`/note?preview=1&${query}`);
  await page.waitForLoadState("networkidle");
  return { ctx, page };
}

test.describe("ズームのプレビュー（付箋側）", () => {
  test("URL の zoom・color で見本の本文を表示し、get_note は呼ばない", async ({ browser }) => {
    const { ctx, page } = await openPreview(browser, "zoom=150&color=blue");

    await expect(page.locator("#markdown-view")).toContainText("新しい付箋はこの大きさで開きます。");
    const zoom = await page.evaluate(() => document.getElementById("note")!.style.zoom);
    expect(parseFloat(zoom)).toBe(1.5);
    expect(await noteBg(page)).toBe("var(--blue)");

    const cmds = await page.evaluate(() =>
      (window as any).__captured_invokes.map((c: any) => c.cmd),
    );
    expect(cmds).not.toContain("get_note");

    await ctx.close();
  });

  test("zoom-preview-update で倍率と色が変わる", async ({ browser }) => {
    const { ctx, page } = await openPreview(browser, "zoom=100&color=yellow");

    const zoom = await page.evaluate(() => {
      (window as any).__appWindowListeners["zoom-preview-update"].forEach((fn: any) =>
        fn({ payload: { zoom: 70, color: "pink" } }),
      );
      return document.getElementById("note")!.style.zoom;
    });
    expect(parseFloat(zoom)).toBe(0.7);
    expect(await noteBg(page)).toBe("var(--pink)");

    await ctx.close();
  });

  test("ズーム操作や移動で保存処理が走っても Rust へ保存を送らない", async ({ browser }) => {
    const { ctx, page } = await openPreview(browser, "zoom=100&color=yellow");

    await page.evaluate(() => {
      (window as any).__captured_invokes.length = 0;
      (window as any).changeZoom(+1);
      (window as any).resetZoom();
    });
    // 内容保存（300ms）・位置保存（500ms）のデバウンスより長く待つ
    await page.waitForTimeout(700);

    const cmds = await page.evaluate(() =>
      (window as any).__captured_invokes.map((c: any) => c.cmd),
    );
    expect(cmds.filter((c: string) => c.startsWith("update_note_"))).toEqual([]);

    await ctx.close();
  });
});

test.describe("ズームのプレビュー（設定画面側）", () => {
  test("スライダーを動かすと、選んでいる倍率と色で preview_zoom を呼ぶ", async ({ openSettings }) => {
    const page = await openSettings();

    await page.click('.color-dot[data-color="green"]');
    let calls = await page.evaluate(() =>
      (window as any).__captured_invokes.filter((c: any) => c.cmd === "preview_zoom"),
    );
    // スライダーに触るまではプレビューを開かない
    expect(calls).toEqual([]);

    await page.locator("#default-zoom-slider").fill("140");
    calls = await page.evaluate(() =>
      (window as any).__captured_invokes.filter((c: any) => c.cmd === "preview_zoom"),
    );
    expect(calls.at(-1).args).toEqual({ zoom: 140, color: "green" });
  });

  test("プレビューを開いた後は、色を変えてもプレビューに反映する", async ({ openSettings }) => {
    const page = await openSettings();

    await page.locator("#default-zoom-slider").fill("120");
    await page.click('.color-dot[data-color="purple"]');

    const calls = await page.evaluate(() =>
      (window as any).__captured_invokes.filter((c: any) => c.cmd === "preview_zoom"),
    );
    expect(calls.at(-1).args).toEqual({ zoom: 120, color: "purple" });
  });
});
