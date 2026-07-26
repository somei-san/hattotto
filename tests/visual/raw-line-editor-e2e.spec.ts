import { test, expect, enterEdit, getContent, placeCaret } from "./fixtures";

const DOC = "# 見出し\n本文\n- 項目";

test.describe("行の生表示と行編集", () => {
  test("クリックした行だけが生 Markdown になり、他行は描画のまま", async ({ openNote }) => {
    const page = await openNote({ content: DOC });

    await enterEdit(page, 1);

    expect(await page.locator("#editor").textContent()).toBe("本文");
    // 見出しと箇条書きは描画されたまま
    await expect(page.locator(".md-h1")).toHaveText("見出し");
    await expect(page.locator(".md-bullet")).toHaveText("項目");
  });

  test("見出し行をクリックすると記号つきの生 Markdown が出る", async ({ openNote }) => {
    const page = await openNote({ content: DOC });

    await enterEdit(page, 0);

    expect(await page.locator("#editor").textContent()).toBe("# 見出し");
    await expect(page.locator(".md-h1")).toHaveCount(0);
  });

  test("別の行をクリックすると前の行は描画に戻る", async ({ openNote }) => {
    const page = await openNote({ content: DOC });

    await enterEdit(page, 0);
    await enterEdit(page, 2);

    expect(await page.locator("#editor").textContent()).toBe("- 項目");
    await expect(page.locator(".md-h1")).toHaveText("見出し");
    await expect(page.locator("#editor")).toHaveCount(1);
  });

  test("↑↓ で隣の行へ移動する", async ({ openNote }) => {
    const page = await openNote({ content: DOC });

    await enterEdit(page, 1);
    await page.keyboard.press("ArrowUp");
    expect(await page.locator("#editor").textContent()).toBe("# 見出し");

    await page.keyboard.press("ArrowDown");
    expect(await page.locator("#editor").textContent()).toBe("本文");
  });

  test("Enter で行が分割される", async ({ openNote }) => {
    const page = await openNote({ content: DOC });

    await placeCaret(page, 1);
    await page.keyboard.press("Enter");
    await page.keyboard.type("追加");

    expect(await getContent(page)).toBe("# 見出し\n本文\n追加\n- 項目");
  });

  test("行頭 Backspace で前の行と結合される", async ({ openNote }) => {
    const page = await openNote({ content: DOC });

    await placeCaret(page, 1, 0);
    await page.keyboard.press("Backspace");

    expect(await getContent(page)).toBe("# 見出し本文\n- 項目");
    // 結合先の行が生表示になっている
    expect(await page.locator("#editor").textContent()).toBe("# 見出し本文");
  });

  test("コードブロックはフェンスごと 1 つの生エディタになる", async ({ openNote }) => {
    const page = await openNote({ content: "```\ncode1\ncode2\n```\nafter" });

    await page.locator(".md-codeblock").click();
    await page.waitForSelector("#editor", { state: "visible" });

    expect(await page.locator("#editor").textContent()).toBe("```\ncode1\ncode2\n```");
    await expect(page.locator("#editor")).toHaveClass(/atomic/);
  });

  test("行をまたぐ選択のまま Backspace しても内容が壊れない", async ({ openNote }) => {
    const page = await openNote({ content: DOC });

    // 1行目と3行目にまたがる選択を作る
    await page.evaluate(() => {
      const view = document.getElementById("markdown-view")!;
      const range = document.createRange();
      range.setStart(view.children[0], 0);
      range.setEnd(view.children[2], 0);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.keyboard.press("Backspace");

    expect(await getContent(page)).toBe(DOC);
  });
});
