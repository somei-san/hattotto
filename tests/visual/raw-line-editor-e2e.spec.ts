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

  // ── 行をまたぐ選択のガード ────────────────────────────
  // 生エディタ側の keydown にも届かせないため、ガードは伝播ごと打ち切る。
  // preventDefault だけではブラウザ既定の編集しか止まらない。

  /** 生表示中の行から、その下の描画済み行へまたがる選択を作る。 */
  async function selectAcrossLines(page: import("@playwright/test").Page) {
    await placeCaret(page, 1, 0);
    await page.evaluate(() => {
      const ed = document.getElementById("editor")!;
      const view = document.getElementById("markdown-view")!;
      const range = document.createRange();
      range.setStart(ed.firstChild ?? ed, 0);
      range.setEnd(view.querySelector('[data-line="2"]')!, 0);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });
  }

  for (const key of ["Backspace", "Delete", "Enter", "Tab"]) {
    test(`行をまたぐ選択のまま ${key} を押しても内容が壊れない`, async ({ openNote }) => {
      const page = await openNote({ content: DOC });
      await selectAcrossLines(page);

      await page.keyboard.press(key);

      expect(await getContent(page)).toBe(DOC);
    });
  }
});

// ── クリック位置 → 生 Markdown の列 ──────────────────────
// 描画テキストには行頭マーカーが出ないため、その分を足し戻して列を決める。

test.describe("クリック位置のキャレット列", () => {
  /** 行の描画テキストの offset 文字目をクリックし、生エディタ内のキャレット列を返す。 */
  async function caretColAfterClick(
    page: import("@playwright/test").Page,
    line: number,
    offset: number,
  ) {
    const box = await page.evaluate(
      ([l, o]) => {
        const el = document.querySelector(`#markdown-view [data-line="${l}"]`)!;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const node = walker.nextNode()!;
        const range = document.createRange();
        range.setStart(node, o as number);
        range.setEnd(node, (o as number) + 1);
        const r = range.getBoundingClientRect();
        return { x: r.left + 1, y: r.top + r.height / 2 };
      },
      [line, offset] as const,
    );
    await page.mouse.click(box.x, box.y);
    await page.waitForSelector("#editor", { state: "visible" });
    return page.evaluate(() => {
      const ed = document.getElementById("editor")!;
      const sel = window.getSelection()!;
      const pre = sel.getRangeAt(0).cloneRange();
      pre.selectNodeContents(ed);
      pre.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
      return pre.toString().length;
    });
  }

  test("見出し行は '# ' の分を足し戻す", async ({ openNote }) => {
    const page = await openNote({ content: "# 見出し" });
    // 描画は「見出し」。先頭をクリックすると生の列は 2（'# ' の直後）
    expect(await caretColAfterClick(page, 0, 0)).toBe(2);
  });

  test("チェックボックス行は '- [ ] ' の分を足し戻す", async ({ openNote }) => {
    const page = await openNote({ content: "- [ ] task" });
    expect(await caretColAfterClick(page, 0, 0)).toBe(6);
  });

  test("引用行は '> ' の分を足し戻す", async ({ openNote }) => {
    const page = await openNote({ content: "> quote" });
    expect(await caretColAfterClick(page, 0, 0)).toBe(2);
  });

  test("番号リストは DOM に出ている連番を二重に数えない", async ({ openNote }) => {
    const page = await openNote({ content: "1. item" });
    expect(await caretColAfterClick(page, 0, 0)).toBe(3);
  });

  test("インデントされた見出しは記号が剥がれないので足し戻さない", async ({ openNote }) => {
    // markdown.js は level > 0 の '# ' を見出しにしない（描画テキストに残る）
    const page = await openNote({ content: "  # foo" });
    expect(await caretColAfterClick(page, 0, 0)).toBe(2);
  });
});
