import { test, expect, enterEdit, placeCaret, getContent } from "./fixtures";

// チェックリスト自動継続直後（`- [ ] ` だけの空項目）で、キャレットが行頭（チェックボックスの
// 左）に落ちず、チェックボックスの後ろ（内容 span のテキストノード）に立つことの回帰テスト。
// 空内容の span は &nbsp; でテキストノードを確保している。

/** 現在の DOM 選択の開始点。ノード種別と、テキストノードなら親要素タグ名を返す。 */
function selectionStart(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    const node = r.startContainer;
    return {
      nodeType: node.nodeType,
      parentTag: node.nodeType === Node.TEXT_NODE ? node.parentElement?.tagName : null,
    };
  });
}

test.describe("空チェックボックス項目のキャレット着地点", () => {
  test("チェックリスト自動継続後、キャレットは div 直下ではなく内容 span 内のテキストノードに立つ", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- [ ] task");
    await page.keyboard.press("Enter");

    const point = await selectionStart(page);
    expect(point?.nodeType).toBe(3); // Node.TEXT_NODE
    expect(point?.parentTag).toBe("SPAN");
  });

  test("placeCaretAtRaw で空チェックボックス行の内容先頭へ置いても div 直下にならない", async ({ openNote }) => {
    const page = await openNote({ content: "- [ ] " });
    await placeCaret(page, 0, 6); // "- [ ] " の直後（内容先頭）

    const point = await selectionStart(page);
    expect(point?.nodeType).toBe(3);
    expect(point?.parentTag).toBe("SPAN");
  });

  test("空チェックボックス項目へ文字入力しても raw content に nbsp が混入しない", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- [ ] task");
    await page.keyboard.press("Enter");
    await page.keyboard.type("x");

    expect(await getContent(page)).toBe("- [ ] task\n- [ ] x");
  });
});
