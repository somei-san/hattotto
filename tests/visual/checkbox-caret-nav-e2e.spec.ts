import { test, expect, placeCaret, getContent } from "./fixtures";

// チェックボックス（<input type="checkbox" contenteditable="false">）は可視文字を持たない
// 空要素のため、その内容先頭（マーカー直後）をまたぐネイティブの矢印移動は、input を挟む
// 要素境界を無音のまま複数回経由してから隣の行へ渡る（実機 WKWebView で「□ にキャレット判定が
// ある」「キャレット移動も変」と報告された挙動）。note.js の keydown ハンドラがこの境界だけを
// 1 回の矢印キーで素通りさせる（詳細は note.js の該当コメント参照）。

/** 現在の DOM 選択の startContainer/offset。境界越えが実際に 1 回で完了したかの検証に使う。 */
function selectionPoint(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    return { nodeType: r.startContainer.nodeType, offset: r.startOffset };
  });
}

test.describe("チェックボックス行の内容先頭をまたぐ矢印移動", () => {
  test("ArrowLeft: 内容先頭から前の行末へ 1 回で移動する", async ({ openNote }) => {
    const page = await openNote({ content: "before\n- [ ] task" });
    await placeCaret(page, 1, 6); // "- [ ] " の直後（内容先頭）
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.type("X", { delay: 10 });
    expect(await getContent(page)).toBe("beforeX\n- [ ] task");
  });

  test("ArrowRight: 前の行末からチェックボックス行の内容先頭へ 1 回で移動する", async ({ openNote }) => {
    const page = await openNote({ content: "before\n- [ ] task" });
    await placeCaret(page, 0, 6); // "before" の行末
    await page.keyboard.press("ArrowRight");
    await page.keyboard.type("X", { delay: 10 });
    expect(await getContent(page)).toBe("before\n- [ ] Xtask");
  });

  test("連続するチェックボックス行: 2 行目の内容先頭から ArrowLeft で 1 行目の行末へ", async ({ openNote }) => {
    const page = await openNote({ content: "- [ ] one\n- [ ] two" });
    await placeCaret(page, 1, 6);
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.type("X", { delay: 10 });
    expect(await getContent(page)).toBe("- [ ] oneX\n- [ ] two");
  });

  test("内容の途中での ArrowLeft/ArrowRight は素通り対象外（ネイティブの行内移動のまま）", async ({ openNote }) => {
    const page = await openNote({ content: "- [ ] task" });
    await placeCaret(page, 0, 10); // 行末
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.type("X", { delay: 10 });
    expect(await getContent(page)).toBe("- [ ] tasXk");
  });

  test("前の行が無いとき（先頭行がチェックボックス行）の ArrowLeft は何もしない", async ({ openNote }) => {
    const page = await openNote({ content: "- [ ] task" });
    await placeCaret(page, 0, 6);
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.type("X", { delay: 10 });
    expect(await getContent(page)).toBe("- [ ] Xtask");
  });

  test("次の行が無いとき（最終行がチェックボックス行）の ArrowRight は何もしない", async ({ openNote }) => {
    const page = await openNote({ content: "- [ ] task" });
    await placeCaret(page, 0, 10);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.type("X", { delay: 10 });
    expect(await getContent(page)).toBe("- [ ] taskX");
  });

  test("ArrowLeft で境界を越えた直後、選択はテキストノードに着地している（要素境界に留まらない）", async ({ openNote }) => {
    const page = await openNote({ content: "before\n- [ ] task" });
    await placeCaret(page, 1, 6);
    await page.keyboard.press("ArrowLeft");
    const point = await selectionPoint(page);
    expect(point?.nodeType).toBe(3); // Node.TEXT_NODE（ページ外の Node.js には DOM グローバルが無い）
  });
});
