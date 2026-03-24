import { test, expect, injectNoteMock } from "./fixtures";

// ── ズーム操作 ──────────────────────────────────────────────

test.describe("ズーム操作", () => {
  test("changeZoom(+1) → zoom が 110% に増加し style.zoom に反映", async ({ openNote }) => {
    const page = await openNote({ content: "テスト", zoom: 100 });

    const zoom = await page.evaluate(() => {
      (window as any).changeZoom(+1);
      return document.getElementById("note")!.style.zoom;
    });
    expect(parseFloat(zoom)).toBe(1.1);
  });

  test("changeZoom(-1) → zoom が 90% に減少", async ({ openNote }) => {
    const page = await openNote({ content: "テスト", zoom: 100 });

    const zoom = await page.evaluate(() => {
      (window as any).changeZoom(-1);
      return document.getElementById("note")!.style.zoom;
    });
    expect(parseFloat(zoom)).toBe(0.9);
  });

  test("resetZoom() → zoom が 100% に戻る", async ({ openNote }) => {
    const page = await openNote({ content: "テスト", zoom: 150 });

    const zoom = await page.evaluate(() => {
      (window as any).resetZoom();
      return document.getElementById("note")!.style.zoom;
    });
    expect(parseFloat(zoom)).toBe(1);
  });

  test("初期 zoom: 80 → style.zoom が 0.8 で読み込まれる", async ({ openNote }) => {
    const page = await openNote({ content: "テスト", zoom: 80 });

    const zoom = await page.evaluate(
      () => document.getElementById("note")!.style.zoom,
    );
    expect(parseFloat(zoom)).toBe(0.8);
  });

  test("zoom 下限: 50% 未満にはならない", async ({ openNote }) => {
    const page = await openNote({ content: "テスト", zoom: 50 });

    const zoom = await page.evaluate(() => {
      (window as any).changeZoom(-1);
      return document.getElementById("note")!.style.zoom;
    });
    // 50 が下限なので変化しない
    expect(parseFloat(zoom)).toBe(0.5);
  });

  test("zoom 上限: 200% を超えない", async ({ openNote }) => {
    const page = await openNote({ content: "テスト", zoom: 200 });

    const zoom = await page.evaluate(() => {
      (window as any).changeZoom(+1);
      return document.getElementById("note")!.style.zoom;
    });
    expect(parseFloat(zoom)).toBe(2);
  });

  test("zoom 変更時に update_note_zoom invoke が呼ばれる", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "テスト", zoom: 100 }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      (window as any).__captured_invokes.length = 0;
      (window as any).changeZoom(+1);
    });

    await expect.poll(() =>
      page.evaluate(() =>
        (window as any).__captured_invokes.filter((c: any) => c.cmd === "update_note_zoom").length,
      ),
      { timeout: 3000 },
    ).toBe(1);

    const calls = await page.evaluate(() =>
      (window as any).__captured_invokes.filter((c: any) => c.cmd === "update_note_zoom"),
    );
    expect((calls[0] as any).args.zoom).toBe(110);

    await ctx.close();
  });
});
