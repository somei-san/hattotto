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

  /** 生エディタ内のキャレット位置（#editor 内での文字オフセット）。 */
  function caretOffsetInEditor(page: import("@playwright/test").Page) {
    return page.evaluate(() => {
      const ed = document.getElementById("editor")!;
      const range = window.getSelection()!.getRangeAt(0);
      const pre = range.cloneRange();
      pre.selectNodeContents(ed);
      pre.setEnd(range.startContainer, range.startOffset);
      return pre.toString().length;
    });
  }

  test("行頭で ← を押すと前の行の末尾へ移る", async ({ openNote }) => {
    const page = await openNote({ content: DOC });

    await placeCaret(page, 1, 0);
    await page.locator("#editor").press("ArrowLeft");

    expect(await page.locator("#editor").textContent()).toBe("# 見出し");
    expect(await caretOffsetInEditor(page)).toBe("# 見出し".length);
  });

  test("行末で → を押すと次の行の先頭へ移る", async ({ openNote }) => {
    const page = await openNote({ content: DOC });

    await placeCaret(page, 1, null);
    await page.locator("#editor").press("ArrowRight");

    expect(await page.locator("#editor").textContent()).toBe("- 項目");
    expect(await caretOffsetInEditor(page)).toBe(0);
  });

  test("行頭以外の ← / 行末以外の → はエディタ内移動のまま", async ({ openNote }) => {
    const page = await openNote({ content: DOC });

    await placeCaret(page, 1, 1);
    await page.locator("#editor").press("ArrowLeft");
    expect(await page.locator("#editor").textContent()).toBe("本文");
    expect(await caretOffsetInEditor(page)).toBe(0);

    await placeCaret(page, 1, 1);
    await page.locator("#editor").press("ArrowRight");
    expect(await page.locator("#editor").textContent()).toBe("本文");
    expect(await caretOffsetInEditor(page)).toBe(2);
  });

  test("先頭行の行頭で ← / 最終行の行末で → は何もしない（境界）", async ({ openNote }) => {
    const page = await openNote({ content: DOC });

    await placeCaret(page, 0, 0);
    await page.locator("#editor").press("ArrowLeft");
    expect(await page.locator("#editor").textContent()).toBe("# 見出し");
    expect(await caretOffsetInEditor(page)).toBe(0);

    await placeCaret(page, 2, null);
    await page.locator("#editor").press("ArrowRight");
    expect(await page.locator("#editor").textContent()).toBe("- 項目");
    expect(await caretOffsetInEditor(page)).toBe("- 項目".length);
  });

  test("Shift+←・Shift+→ は選択拡張のままで行をまたがない", async ({ openNote }) => {
    const page = await openNote({ content: DOC });

    await placeCaret(page, 1, 0);
    await page.locator("#editor").press("Shift+ArrowLeft");
    expect(await page.locator("#editor").textContent()).toBe("本文");

    await placeCaret(page, 1, null);
    await page.locator("#editor").press("Shift+ArrowRight");
    expect(await page.locator("#editor").textContent()).toBe("本文");
  });

  test("選択中に修飾なし ← を押すと選択が畳まれるだけで行をまたがない", async ({ openNote }) => {
    const page = await openNote({ content: DOC });

    await placeCaret(page, 1, 0);
    // 行頭から1文字選択する。選択の開始位置（Range の左端）は行頭 col0 のままなので、
    // caretLineCol だけで判定すると「行頭にいる」と誤認しかねない
    await page.locator("#editor").press("Shift+ArrowRight");
    await page.locator("#editor").press("ArrowLeft");

    expect(await page.locator("#editor").textContent()).toBe("本文");
    expect(await caretOffsetInEditor(page)).toBe(0);
  });

  test("フェンス複数行ブロックの途中の行頭 ← / 行末 → はエディタ内のネイティブ移動のまま", async ({ openNote }) => {
    const page = await openNote({ content: "```\ncode1\ncode2\n```\nafter" });
    await page.locator(".md-codeblock").click();
    await page.waitForSelector("#editor", { state: "visible" });

    await placeCaret(page, 2, 0); // "code2" 行の行頭（ブロックの先頭行ではない）
    await page.locator("#editor").press("ArrowLeft");
    expect(await page.locator("#editor").textContent()).toBe("```\ncode1\ncode2\n```");
    expect(await caretOffsetInEditor(page)).toBe("```\ncode1".length);

    await placeCaret(page, 1, null); // "code1" 行の行末（ブロックの最終行ではない）
    await page.locator("#editor").press("ArrowRight");
    expect(await page.locator("#editor").textContent()).toBe("```\ncode1\ncode2\n```");
    expect(await caretOffsetInEditor(page)).toBe("```\ncode1\n".length);
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

// ── Ctrl+A/E の行頭・行末移動 ─────────────────────────────
// 実機の WKWebView は contenteditable 上で Ctrl+A/E を標準キーバインドとして処理しない
// ため、note.js が自前実装している（#69）。テストで使う Chromium は逆にネイティブで
// 行頭・行末移動を処理するが、自前実装が preventDefault で上書きするため、ここでの
// 検証は自前実装側の回帰を検出する。

test.describe("Ctrl+A/E の行頭・行末移動", () => {
  /** 生エディタ内のキャレット位置（選択の折り畳み状態つき）。 */
  function caretState(page: import("@playwright/test").Page) {
    return page.evaluate(() => {
      const ed = document.getElementById("editor")!;
      const sel = window.getSelection()!;
      const range = sel.getRangeAt(0);
      const pre = range.cloneRange();
      pre.selectNodeContents(ed);
      pre.setEnd(range.startContainer, range.startOffset);
      return { offset: pre.toString().length, collapsed: sel.isCollapsed };
    });
  }

  /** 生エディタ内の選択の anchor/focus 位置（折り畳み状態つき）。 */
  function selectionState(page: import("@playwright/test").Page) {
    return page.evaluate(() => {
      const ed = document.getElementById("editor")!;
      const sel = window.getSelection()!;
      const offsetOf = (node: Node, offset: number) => {
        const r = document.createRange();
        r.selectNodeContents(ed);
        r.setEnd(node, offset);
        return r.toString().length;
      };
      return {
        collapsed: sel.isCollapsed,
        anchorOffset: offsetOf(sel.anchorNode!, sel.anchorOffset),
        focusOffset: offsetOf(sel.focusNode!, sel.focusOffset),
      };
    });
  }

  test("Ctrl+A でキャレットが行頭へ移動する（選択されない）", async ({ openNote }) => {
    const page = await openNote({ content: DOC });

    await placeCaret(page, 1, 1);
    await page.keyboard.press("Control+a");

    expect(await caretState(page)).toEqual({ offset: 0, collapsed: true });
  });

  test("Ctrl+E でキャレットが行末へ移動する（選択されない）", async ({ openNote }) => {
    const page = await openNote({ content: DOC });

    await placeCaret(page, 1, 1);
    await page.keyboard.press("Control+e");

    expect(await caretState(page)).toEqual({ offset: 2, collapsed: true });
  });

  test("⌘A はブロック内全選択のまま（回帰）", async ({ openNote }) => {
    const page = await openNote({ content: DOC });

    await placeCaret(page, 1, 1);
    await page.keyboard.press("Meta+a");

    const state = await caretState(page);
    expect(state.collapsed).toBe(false);
    expect(await page.evaluate(() => window.getSelection()!.toString())).toBe("本文");
  });

  test("Ctrl+⌘+A は何もしない（未定義の修飾キー組み合わせは macOS 標準に合わせて無視する）", async ({ openNote }) => {
    const page = await openNote({ content: DOC });

    await placeCaret(page, 1, 1);
    await page.keyboard.press("Control+Meta+a");

    expect(await caretState(page)).toEqual({ offset: 1, collapsed: true });
  });

  test("Shift+Ctrl+A は行頭まで選択を拡張する（キャレット移動に化けない）", async ({ openNote }) => {
    const page = await openNote({ content: DOC });

    await placeCaret(page, 1, 1);
    await page.keyboard.press("Control+Shift+A");

    expect(await selectionState(page)).toEqual({ collapsed: false, anchorOffset: 1, focusOffset: 0 });
    expect(await page.evaluate(() => window.getSelection()!.toString())).toBe("本");
  });

  test("Shift+Ctrl+E は行末まで選択を拡張する（キャレット移動に化けない）", async ({ openNote }) => {
    const page = await openNote({ content: DOC });

    await placeCaret(page, 1, 1);
    await page.keyboard.press("Control+Shift+E");

    expect(await selectionState(page)).toEqual({ collapsed: false, anchorOffset: 1, focusOffset: 2 });
    expect(await page.evaluate(() => window.getSelection()!.toString())).toBe("文");
  });

  test("atomic な行で Ctrl+E の後、キャレットが横スクロールで可視範囲に入る", async ({ openNote }) => {
    const longLine = "x".repeat(200);
    const page = await openNote({ content: `\`\`\`\n${longLine}\n\`\`\`` });

    await placeCaret(page, 1, 0);
    await page.keyboard.press("Control+e");

    const scrollLeft = await page.locator("#editor").evaluate((el) => el.scrollLeft);
    expect(scrollLeft).toBeGreaterThan(0);
  });
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
