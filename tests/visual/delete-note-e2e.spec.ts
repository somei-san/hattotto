import { test, expect, injectNoteMock } from "./fixtures";

// ── 付箋削除・新規作成 ──────────────────────────────────────

test.describe("付箋削除・新規作成", () => {
  test("削除ボタン → delete_note invoke が呼ばれる", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "テスト" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => { (window as any).__captured_invokes.length = 0; });
    await page.click("#btn-delete");

    await expect.poll(() =>
      page.evaluate(() =>
        (window as any).__captured_invokes.filter((c: any) => c.cmd === "delete_note").length,
      ),
      { timeout: 3000 },
    ).toBe(1);

    await ctx.close();
  });

  test("新規付箋ボタン → create_note invoke が呼ばれる", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => { (window as any).__captured_invokes.length = 0; });
    await page.click("#btn-new");

    await expect.poll(() =>
      page.evaluate(() =>
        (window as any).__captured_invokes.filter((c: any) => c.cmd === "create_note").length,
      ),
      { timeout: 3000 },
    ).toBe(1);

    await ctx.close();
  });
});
