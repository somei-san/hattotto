import { test, expect, injectNoteMock, enterEdit } from "./fixtures";

const IMAGE_PATH = "images/00000000-0000-4000-8000-000000000001.png";
const CONTENT = `![](${IMAGE_PATH})`;

// asset:// URL はテスト環境では実在しないため <img> は読み込みに失敗し、
// alt="" の壊れた画像は Chromium 上でレイアウトサイズ 0 になる。
// Playwright のマウス操作は座標依存で 0 サイズの要素を扱えないため、
// note.js のリスナーが拾うイベントを img 要素へ直接 dispatch する。
function dispatchOnImage(type: string, options: MouseEventInit = {}) {
  const img = document.querySelector("img")!;
  img.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...options }));
}

test.describe("画像のダブルクリック・右クリックメニュー", () => {
  test("画像のシングルクリック → 生表示に入らない", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: CONTENT }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(dispatchOnImage, "mouseup");

    await expect(page.locator("#editor")).toHaveCount(0);

    await ctx.close();
  });

  test("画像のダブルクリック → open_image が正しい相対パスで呼ばれる", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: CONTENT }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(dispatchOnImage, "dblclick");

    await expect.poll(() =>
      page.evaluate(() =>
        (window as any).__captured_invokes.filter((c: any) => c.cmd === "open_image").length,
      ),
    ).toBe(1);

    const calls = await page.evaluate(() =>
      (window as any).__captured_invokes.filter((c: any) => c.cmd === "open_image"),
    );
    expect(calls[0].args).toEqual({ imagePath: IMAGE_PATH });

    await ctx.close();
  });

  test("画像上での右クリック → show_context_menu に imagePath が渡る", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: CONTENT }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(dispatchOnImage, "contextmenu");

    await expect.poll(() =>
      page.evaluate(() =>
        (window as any).__captured_invokes.filter((c: any) => c.cmd === "show_context_menu").length,
      ),
    ).toBe(1);

    const calls = await page.evaluate(() =>
      (window as any).__captured_invokes.filter((c: any) => c.cmd === "show_context_menu"),
    );
    expect(calls[0].args.imagePath).toBe(IMAGE_PATH);

    await ctx.close();
  });

  test("画像以外での右クリック → show_context_menu に imagePath が渡らない", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "plain text" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.locator("#markdown-view").click({ button: "right" });

    await expect.poll(() =>
      page.evaluate(() =>
        (window as any).__captured_invokes.filter((c: any) => c.cmd === "show_context_menu").length,
      ),
    ).toBe(1);

    const calls = await page.evaluate(() =>
      (window as any).__captured_invokes.filter((c: any) => c.cmd === "show_context_menu"),
    );
    expect(calls[0].args.imagePath).toBeUndefined();

    await ctx.close();
  });

  test("画像行を含む付箋の余白クリック → 画像以外の行が生表示になる（画像行が編集不能になる退行の固定）", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `${CONTENT}\nテキスト行` }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    // 余白クリック（enterEdit の line 省略）は最終行の生表示に入る
    await enterEdit(page);

    await expect(page.locator("#editor")).toBeVisible();
    expect(await page.locator("#editor").textContent()).toBe("テキスト行");

    await ctx.close();
  });

  test("img の data-rel-src を DOM 改変してからダブルクリック → open_image は invoke されない", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: CONTENT }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      const img = document.querySelector("img")!;
      img.dataset.relSrc = "images/../notes.json";
    });
    await page.evaluate(dispatchOnImage, "dblclick");

    // invoke されないことを確定させるため、明示的に待ってから0件であることを確認する
    await page.waitForTimeout(100);
    const calls = await page.evaluate(() =>
      (window as any).__captured_invokes.filter((c: any) => c.cmd === "open_image"),
    );
    expect(calls.length).toBe(0);

    await ctx.close();
  });
});
