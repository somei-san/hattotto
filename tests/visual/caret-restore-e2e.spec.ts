import { test, expect } from "./fixtures";

test.describe("キャレット復帰", () => {
  test("複数行テキストの2行目クリック → カーソルが2行目先頭に復帰", async ({ openNote }) => {
    const page = await openNote({
      content: "first line\nsecond line\nthird line",
    });

    // プレビューモードであることを確認
    await expect(page.locator(".markdown-view")).toBeVisible();

    // プレビューの2行目（index=1）の要素をクリック
    // markdown-view の子要素の2番目をクリック
    await page.evaluate(() => {
      const mdView = document.getElementById("markdown-view")!;
      const children = Array.from(mdView.children);
      if (children.length > 1) {
        (children[1] as HTMLElement).click();
      }
    });

    await expect(page.locator(".editor")).toBeVisible();

    // キャレット位置を取得
    const caretOffset = await page.evaluate(() => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return -1;
      const range = sel.getRangeAt(0);
      // エディタ内のテキストノードを走査して絶対位置を計算
      const editor = document.getElementById("editor")!;
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      let offset = 0;
      let node;
      while ((node = walker.nextNode())) {
        if (node === range.startContainer) {
          return offset + range.startOffset;
        }
        offset += node.textContent!.length;
      }
      return -1;
    });

    // "first line\n" の長さ = 11 → 2行目先頭は offset 11
    expect(caretOffset).toBe(11);
  });

  test("1行目クリック → カーソルが1行目先頭に復帰", async ({ openNote }) => {
    const page = await openNote({
      content: "first line\nsecond line",
    });

    await expect(page.locator(".markdown-view")).toBeVisible();

    // プレビューの1行目（index=0）をクリック
    await page.evaluate(() => {
      const mdView = document.getElementById("markdown-view")!;
      const children = Array.from(mdView.children);
      if (children.length > 0) {
        (children[0] as HTMLElement).click();
      }
    });

    await expect(page.locator(".editor")).toBeVisible();

    const caretOffset = await page.evaluate(() => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return -1;
      const range = sel.getRangeAt(0);
      const editor = document.getElementById("editor")!;
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      let offset = 0;
      let node;
      while ((node = walker.nextNode())) {
        if (node === range.startContainer) {
          return offset + range.startOffset;
        }
        offset += node.textContent!.length;
      }
      return -1;
    });

    // 1行目先頭は offset 0
    expect(caretOffset).toBe(0);
  });

  test("3行目クリック → カーソルが3行目先頭に復帰", async ({ openNote }) => {
    const page = await openNote({
      content: "aaa\nbbbb\nccccc",
    });

    await expect(page.locator(".markdown-view")).toBeVisible();

    await page.evaluate(() => {
      const mdView = document.getElementById("markdown-view")!;
      const children = Array.from(mdView.children);
      if (children.length > 2) {
        (children[2] as HTMLElement).click();
      }
    });

    await expect(page.locator(".editor")).toBeVisible();

    const caretOffset = await page.evaluate(() => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return -1;
      const range = sel.getRangeAt(0);
      const editor = document.getElementById("editor")!;
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      let offset = 0;
      let node;
      while ((node = walker.nextNode())) {
        if (node === range.startContainer) {
          return offset + range.startOffset;
        }
        offset += node.textContent!.length;
      }
      return -1;
    });

    // "aaa\n" (4) + "bbbb\n" (5) = 9 → 3行目先頭は offset 9
    expect(caretOffset).toBe(9);
  });
});
