import { test, expect, enterEdit, getContent, selectMarkdownRange } from "./fixtures";

// 行またぎ選択（markdown-view の描画テキスト上の Range）に対する削除系の操作。
// resolveSelectionBounds で生 Markdown の範囲へ解決し、行を splice して applyLines で
// 再描画・保存する。タイピング・ペーストによる置換系の操作は selection-replace-e2e.spec.ts
// を参照。組み立てられない破壊的操作（Dead key 等）は Cross-line Selection Guard がブロックする。

const IMAGE_PATH = "images/00000000-0000-4000-8000-000000000001.png";
const IMAGE_LINE = `![](${IMAGE_PATH})`;

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

/** document へ cut の ClipboardEvent を dispatch し、preventDefault の有無とセットされた
 * text/html・text/plain を返す。 */
function dispatchCutWithClipboardData(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const dt = new DataTransfer();
    const ev = new ClipboardEvent("cut", { bubbles: true, cancelable: true, clipboardData: dt });
    const notCanceled = document.dispatchEvent(ev);
    return { notCanceled, html: dt.getData("text/html"), plain: dt.getData("text/plain") };
  });
}

test.describe("⌘A（selectAllNote）", () => {
  test("生エディタが開いた状態からの ⌘A → 生エディタが閉じ、付箋全体が選択される", async ({ openNote }) => {
    const page = await openNote({ content: "# Heading\nbody line\n- item" });
    await enterEdit(page, 1);

    await page.keyboard.press("Meta+a");

    await expect(page.locator("#editor")).toHaveCount(0);
    expect(await page.evaluate(() => window.getSelection()!.isCollapsed)).toBe(false);
    expect(await page.evaluate(() => window.getSelection()!.toString())).toBe("Heading\nbody line\nitem");
  });

  test("空の付箋への ⌘A → 選択対象が無いので何も選択されない", async ({ openNote }) => {
    const page = await openNote({ content: "" });

    await page.keyboard.press("Meta+a");

    expect(await page.evaluate(() => window.getSelection()!.rangeCount)).toBe(0);
    await expect(page.locator("#editor")).toHaveCount(0);
  });
});

test.describe("行またぎ選択の Backspace / Delete 削除", () => {
  test("装飾記法・リスト・見出しを含む範囲の削除 → 選択範囲だけが取り除かれ前後が結合する", async ({ openNote }) => {
    const content = ["# Heading", "**bold** text", "- item one", "- item two", "tail"].join("\n");
    const page = await openNote({ content });

    // 2行目（"bold text" の先頭）〜4行目（"item two" の "item " の直後）を選択
    await selectMarkdownRange(page, 1, 0, 3, "item ".length);
    await page.keyboard.press("Backspace");

    expect(await getContent(page)).toBe("# Heading\ntwo\ntail");
  });

  test("コードブロックの内容全選択削除 → フェンスごと消える", async ({ openNote }) => {
    const content = ["before", "```", "code line", "```", "after"].join("\n");
    const page = await openNote({ content });

    await page.evaluate(() => {
      const codeEl = document.querySelector("#markdown-view pre.md-codeblock code")!;
      const range = document.createRange();
      range.selectNodeContents(codeEl); // 内容行の可視テキスト全体を選択 → フェンスまで拡張される
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.keyboard.press("Delete");

    expect(await getContent(page)).toBe("before\n\nafter");
  });

  test("部分削除で行が結合し、キャレットが削除範囲の開始位置に残る", async ({ openNote }) => {
    const page = await openNote({ content: "hello\nworld" });

    // "hello" の "lo"（1行目末尾2文字）〜 "world" の "wo"（2行目先頭2文字）を選択
    await selectMarkdownRange(page, 0, 3, 1, 2);
    await page.keyboard.press("Backspace");

    expect(await getContent(page)).toBe("helrld");
    await expect(page.locator("#editor")).toBeVisible();
    expect(await caretOffsetInEditor(page)).toBe(3);
  });

  test("付箋全体を選択して削除 → 空 1 行になり、キャレットは (0,0)", async ({ openNote }) => {
    const page = await openNote({ content: "line1\nline2" });

    await page.evaluate(() => (window as unknown as { selectAllNote(): void }).selectAllNote());
    await page.keyboard.press("Backspace");

    expect(await getContent(page)).toBe("");
    await expect(page.locator("#editor")).toBeVisible();
    expect(await caretOffsetInEditor(page)).toBe(0);
  });
});

test.describe("行またぎ選択の ⌘X", () => {
  test("copy と同じ payload がクリップボードへ載り、選択範囲が削除される", async ({ openNote }) => {
    const page = await openNote({ content: "**bold** line\nsecond line" });

    await selectMarkdownRange(page, 0, 0, 1, "second line".length);
    const { notCanceled, html, plain } = await dispatchCutWithClipboardData(page);

    expect(notCanceled).toBe(false); // preventDefault された
    expect(html).toContain("<strong>bold</strong>");
    expect(plain).toBe("bold line\nsecond line");
    expect(plain).not.toContain("**");

    expect(await getContent(page)).toBe("");
  });
});

test.describe("行またぎ選択の Escape", () => {
  test("選択が解除されるだけで、キャレットは立たない", async ({ openNote }) => {
    const page = await openNote({ content: "line1\nline2" });

    await selectMarkdownRange(page, 0, 0, 1, "line2".length);
    await page.keyboard.press("Escape");

    expect(await page.evaluate(() => window.getSelection()!.rangeCount)).toBe(0);
    await expect(page.locator("#editor")).toHaveCount(0);
    expect(await getContent(page)).toBe("line1\nline2");
  });
});

test.describe("行またぎ選択の無修飾矢印キー", () => {
  test("←/↑ で選択開始端へキャレットが畳まれる", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef\nghi" });

    await selectMarkdownRange(page, 0, 1, 2, 2);
    await page.keyboard.press("ArrowLeft");

    await expect(page.locator("#editor")).toBeVisible();
    expect(await page.evaluate(() => window.getSelection()!.isCollapsed)).toBe(true);
    expect(await caretOffsetInEditor(page)).toBe(1);
    expect(await page.locator("#editor").textContent()).toBe("abc");
  });

  test("→/↓ で選択終了端へキャレットが畳まれる", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef\nghi" });

    await selectMarkdownRange(page, 0, 1, 2, 2);
    await page.keyboard.press("ArrowRight");

    await expect(page.locator("#editor")).toBeVisible();
    expect(await page.evaluate(() => window.getSelection()!.isCollapsed)).toBe(true);
    expect(await caretOffsetInEditor(page)).toBe(2);
    expect(await page.locator("#editor").textContent()).toBe("ghi");
  });
});

test.describe("行またぎ選択中は引き続きブロックされる操作（ガード残置）", () => {
  // タイピング・ペーストによる置換は selection-replace-e2e.spec.ts を参照。ここは
  // 組み立てられない破壊的操作（Dead key 相当・Shift/⌥ 付きの編集キー等）だけを扱う。

  // 生エディタに触れない純粋な mdView 選択でも、Shift/⌥ 付きの破壊的キーはブロックされる
  // ことを確認する（生エディタに触れる選択のケースは別 describe ブロックで確認済み）。
  test("Shift+Enter はブロックされ、内容が変わらない", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef" });

    await selectMarkdownRange(page, 0, 0, 1, "def".length);
    await page.keyboard.press("Shift+Enter");

    expect(await getContent(page)).toBe("abc\ndef");
  });

  test("⌥Backspace はブロックされ、内容が変わらない", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef" });

    await selectMarkdownRange(page, 0, 0, 1, "def".length);
    await page.keyboard.press("Alt+Backspace");

    expect(await getContent(page)).toBe("abc\ndef");
  });
});

test.describe("行またぎ選択の削除は undo で戻る", () => {
  test("Backspace で削除 → performUndo で元の内容に戻る", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef" });

    await selectMarkdownRange(page, 0, 0, 1, "def".length);
    await page.keyboard.press("Backspace");
    expect(await getContent(page)).toBe("");

    // scheduleSave() の 300ms デバウンスが確定し、history.commit が積まれるのを待つ
    await page.waitForTimeout(400);
    await page.evaluate(() => (window as unknown as { performUndo(): Promise<void> }).performUndo());

    expect(await getContent(page)).toBe("abc\ndef");
  });
});

test.describe("行またぎ選択中でも生エディタに触れる選択は既定の編集操作に譲る（ガードの誤ブロック防止）", () => {
  /** 生エディタ内の起点から、別の描画済み行（mdView 側）まで伸びる DOM 選択を張る。
   * 生エディタが focus を持ったまま、選択（Range）だけが行をまたぐ状態を再現する
   * （selectionSpansLines は true だが、選択は生エディタに触れている）。 */
  async function selectFromEditorIntoRenderedLine(page: import("@playwright/test").Page, renderedLine: number) {
    await page.evaluate((l) => {
      const ed = document.getElementById("editor")!;
      const other = document.querySelector(`#markdown-view [data-line="${l}"]`)!;
      const range = document.createRange();
      range.setStart(ed.firstChild ?? ed, 0);
      range.setEnd(other.firstChild ?? other, 0);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    }, renderedLine);
  }

  test("Shift+Enter はブロックされ、行分割されない", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef" });
    await enterEdit(page, 0);
    await selectFromEditorIntoRenderedLine(page, 1);

    await page.keyboard.press("Shift+Enter");

    expect(await getContent(page)).toBe("abc\ndef");
  });

  test("Shift+Tab はブロックされ、インデントされない", async ({ openNote }) => {
    const page = await openNote({ content: "- abc\ndef" });
    await enterEdit(page, 0);
    await selectFromEditorIntoRenderedLine(page, 1);

    await page.keyboard.press("Shift+Tab");

    expect(await getContent(page)).toBe("- abc\ndef");
  });

  test("⌥Backspace はブロックされ、単語削除されない", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef" });
    await enterEdit(page, 0);
    await selectFromEditorIntoRenderedLine(page, 1);

    await page.keyboard.press("Alt+Backspace");

    expect(await getContent(page)).toBe("abc\ndef");
  });

  test("実キー ⌘X はネイティブ cut に委ねられず、何も変更しない", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef" });
    await enterEdit(page, 0);
    await selectFromEditorIntoRenderedLine(page, 1);

    await page.keyboard.press("ControlOrMeta+x");

    expect(await getContent(page)).toBe("abc\ndef");
  });

  // 実アプリではネイティブ Edit メニューの Cut が ⌘X を先取りし、keydown ガードを通らずに
  // cut イベントが直接届く。その経路（cut イベントの直接 dispatch で再現）でもブロックされること
  test("cut イベント直接（ネイティブメニュー経由相当）もブロックされ、何も変更しない", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef" });
    await enterEdit(page, 0);
    await selectFromEditorIntoRenderedLine(page, 1);

    const { notCanceled, html, plain } = await dispatchCutWithClipboardData(page);

    expect(notCanceled).toBe(false); // preventDefault されている（既定の cut に落ちない）
    expect(html).toBe("");
    expect(plain).toBe("");
    expect(await getContent(page)).toBe("abc\ndef");
  });
});

test.describe("行またぎ選択の実キー ⌘X", () => {
  test("dispatch ではなく実際のキー操作でも削除される", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef" });

    await selectMarkdownRange(page, 0, 0, 1, "def".length);
    await page.keyboard.press("ControlOrMeta+x");

    expect(await getContent(page)).toBe("");
  });
});

test.describe("行をまたがない非空の単一行選択の削除（コピー範囲 = 削除範囲）", () => {
  test("⌘A → Backspace で全消去される", async ({ openNote }) => {
    const page = await openNote({ content: "hello" });

    await page.keyboard.press("Meta+a");
    await page.keyboard.press("Backspace");

    expect(await getContent(page)).toBe("");
  });

  test("⌘A → ⌘X で全消去される", async ({ openNote }) => {
    const page = await openNote({ content: "hello" });

    await page.keyboard.press("Meta+a");
    await page.keyboard.press("ControlOrMeta+x");

    expect(await getContent(page)).toBe("");
  });
});

test.describe("マーカー付き行を終端とする選択の →/↓ 畳み", () => {
  test("キャレットはマーカー直後（可視位置）に置かれ、行頭には畳まれない", async ({ openNote }) => {
    const page = await openNote({ content: "abc\n- item\nxyz" });

    // 1行目の可視オフセット 0（"- " マーカー直後、内容は 1 文字も選択していない）で終える選択
    await selectMarkdownRange(page, 0, 1, 1, 0);
    await page.keyboard.press("ArrowRight");

    await expect(page.locator("#editor")).toBeVisible();
    expect(await page.locator("#editor").textContent()).toBe("- item");
    expect(await caretOffsetInEditor(page)).toBe(2); // "- " の直後（マーカー分の 2 列目）
  });
});

test.describe("マーカー付き行を開始端とする選択の ←/↑ 畳み", () => {
  test("キャレットはマーカー直後（可視位置）に置かれ、行頭には畳まれない", async ({ openNote }) => {
    const page = await openNote({ content: "- item\nxyz" });

    // 0行目の可視オフセット 0（"- " マーカー直後）から始める選択
    await selectMarkdownRange(page, 0, 0, 1, 2);
    await page.keyboard.press("ArrowLeft");

    await expect(page.locator("#editor")).toBeVisible();
    expect(await page.locator("#editor").textContent()).toBe("- item");
    expect(await caretOffsetInEditor(page)).toBe(2); // "- " の直後（マーカー分の 2 列目）
  });
});

test.describe("画像行を含む範囲削除", () => {
  test("削除後に開始行が画像のみの行になっても、画像選択が残り操作不能にならない", async ({ openNote }) => {
    const page = await openNote({ content: `abc\n${IMAGE_LINE}\ndef` });

    await selectMarkdownRange(page, 0, 0, 1, 0);
    await page.keyboard.press("Backspace");

    expect(await getContent(page)).toBe(`${IMAGE_LINE}\ndef`);
    // 生エディタも画像選択も無い操作不能状態になっていないこと
    const editorCount = await page.locator("#editor").count();
    const selectedImageCount = await page.locator(".img-selected").count();
    expect(editorCount > 0 || selectedImageCount > 0).toBe(true);
  });

  test("削除範囲外の画像が選択中でも、テキスト範囲の Backspace で表示が壊れない", async ({ openNote }) => {
    const page = await openNote({ content: `${IMAGE_LINE}\nabc\ndef\nghi` });

    // 0行目（画像のみの行）へ enterLine すると selectImage が呼ばれ、画像選択状態になる
    await page.evaluate(
      () => (window as unknown as { enterLine(l: number, c: number | null): void }).enterLine(0, null),
    );
    await expect(page.locator(".img-selected")).toHaveCount(1);

    await selectMarkdownRange(page, 1, 0, 2, "def".length);
    await page.keyboard.press("Backspace");

    expect(await getContent(page)).toBe(`${IMAGE_LINE}\n\nghi`);
    await expect(page.locator("#editor")).toBeVisible();
    // 画像自体は消えておらず、表示も壊れていない
    await expect(page.locator("#markdown-view img")).toHaveCount(1);
  });
});
