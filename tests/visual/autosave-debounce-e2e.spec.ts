import { test, expect, injectNoteMock } from "./fixtures";

test.describe("自動保存デバウンス", () => {
  test("高速連続入力 → 最後の入力から300ms後に1回だけinvoke", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    // 編集モードにする
    await page.click(".markdown-view");
    await expect(page.locator(".editor")).toBeVisible();

    // キャプチャをリセット
    await page.evaluate(() => { (window as any).__captured_invokes.length = 0; });

    // 高速で5文字連続入力（各入力間にデバウンスリセットが起こる）
    await page.locator(".editor").pressSequentially("abcde", { delay: 50 });

    // 入力直後（50ms * 5 = 250ms程度）はまだデバウンス中
    const callsImmediate = await page.evaluate(() =>
      (window as any).__captured_invokes.filter((c: any) => c.cmd === "update_note_content").length
    );
    expect(callsImmediate).toBe(0);

    // デバウンス完了を待機（最後の入力から300ms）
    await expect.poll(() =>
      page.evaluate(() =>
        (window as any).__captured_invokes.filter((c: any) => c.cmd === "update_note_content").length
      ),
      { timeout: 5000 },
    ).toBe(1);

    // invoke が正確に1回だけ呼ばれ、最後の入力内容が含まれていることを確認
    const calls = await page.evaluate(() =>
      (window as any).__captured_invokes.filter((c: any) => c.cmd === "update_note_content")
    );
    expect(calls).toHaveLength(1);
    expect((calls[0] as any).args.content).toContain("abcde");

    await ctx.close();
  });

  test("デバウンス中の再入力 → タイマーリセットされ最終的に1回だけinvoke", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.click(".markdown-view");
    await expect(page.locator(".editor")).toBeVisible();

    await page.evaluate(() => { (window as any).__captured_invokes.length = 0; });

    // 1文字入力
    await page.locator(".editor").press("x");

    // 200ms待機（300msデバウンス内）
    await page.waitForTimeout(200);

    // デバウンスタイマー内にもう1文字入力 → タイマーリセット
    await page.locator(".editor").press("y");

    // この時点ではまだinvokeされていない
    const callsMid = await page.evaluate(() =>
      (window as any).__captured_invokes.filter((c: any) => c.cmd === "update_note_content").length
    );
    expect(callsMid).toBe(0);

    // 最後の入力から300ms+α待機してinvokeを確認
    await expect.poll(() =>
      page.evaluate(() =>
        (window as any).__captured_invokes.filter((c: any) => c.cmd === "update_note_content").length
      ),
      { timeout: 5000 },
    ).toBe(1);

    // 最終コンテンツに両方の文字が含まれている
    const calls = await page.evaluate(() =>
      (window as any).__captured_invokes.filter((c: any) => c.cmd === "update_note_content")
    );
    expect(calls).toHaveLength(1);
    expect((calls[0] as any).args.content).toContain("x");
    expect((calls[0] as any).args.content).toContain("y");

    await ctx.close();
  });
});
