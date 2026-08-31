import { test, expect, enterEdit, getContent, selectMarkdownRange } from "./fixtures";

// 行またぎ選択（markdown-view の描画テキスト上の Range）に対する削除系の操作。
// resolveSelectionBounds で生 Markdown の範囲へ解決し、行を splice して applyLines で
// 再描画・保存する。タイピング・ペーストによる置換系の操作は selection-replace-e2e.spec.ts
// を参照。組み立てられない破壊的操作（Dead key 等）は Cross-line Selection Guard がブロックする。

const IMAGE_PATH = "images/00000000-0000-4000-8000-000000000001.png";
const IMAGE_LINE = `![](${IMAGE_PATH})`;

/** 現在のキャレットが属する行番号（data-line）。無ければ null。 */
function caretLine(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const node = window.getSelection()?.anchorNode ?? null;
    const el = node instanceof Element ? node : node?.parentElement;
    const line = el?.closest("[data-line]")?.getAttribute("data-line");
    return line == null ? null : Number(line);
  });
}

/** 現在のキャレット位置の raw 列（行頭マーカーぶんを加算した位置）。インデント付き
 * マーカーは対象外（このファイルのフィクスチャはインデント無しのマーカーのみ使う）。 */
function caretRawColumn(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return -1;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    const lineEl = el?.closest("[data-line]");
    if (!lineEl) return -1;
    const pre = document.createRange();
    pre.selectNodeContents(lineEl);
    pre.setEnd(range.startContainer, range.startOffset);
    const visible = pre.toString().length;
    const lineIdx = Number(lineEl.getAttribute("data-line"));
    const raw = ((window as unknown as { getRawContent(): string }).getRawContent().split("\n"))[lineIdx];
    const m = raw.match(/^(#{1,3} |[-*] \[[ xX]\] |[-*] |> |\d+\. )/);
    return (m ? m[0].length : 0) + visible;
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
  test("キャレットが置かれた状態からの ⌘A → 付箋全体が選択される", async ({ openNote }) => {
    const page = await openNote({ content: "# Heading\nbody line\n- item" });
    await enterEdit(page, 1);

    await page.keyboard.press("Meta+a");

    expect(await page.evaluate(() => window.getSelection()!.isCollapsed)).toBe(false);
    expect(await page.evaluate(() => window.getSelection()!.toString())).toBe("Heading\nbody line\nitem");
  });

  test("空の付箋への ⌘A → 選択対象が無いので何も選択されない", async ({ openNote }) => {
    const page = await openNote({ content: "" });

    await page.keyboard.press("Meta+a");

    expect(await page.evaluate(() => window.getSelection()!.rangeCount)).toBe(0);
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
    expect(await caretLine(page)).toBe(0);
    expect(await caretRawColumn(page)).toBe(3);
  });

  test("付箋全体を選択して削除 → 空 1 行になり、キャレットは (0,0)", async ({ openNote }) => {
    const page = await openNote({ content: "line1\nline2" });

    await page.evaluate(() => (window as unknown as { selectAllNote(): void }).selectAllNote());
    await page.keyboard.press("Backspace");

    expect(await getContent(page)).toBe("");
    expect(await caretLine(page)).toBe(0);
    expect(await caretRawColumn(page)).toBe(0);
  });
});

test.describe("行頭マーカーを含む行またぎ選択の削除", () => {
  // resolveSelectionBounds は「開始行の可視オフセットが 0（マーカー直後）」の選択を raw col 0
  // （マーカー込み）へ正規化し、「終了行の可視オフセットが 0（内容は 1 文字も選んでいない）」の
  // 選択は raw col 0 のまま（マーカーへは踏み込まない）にする。この 2 つの正規化がそれぞれ
  // widenRangeForEmptiedDecorations を lo < markerLen・hi < markerLen で呼ぶ経路になる。

  test("開始行が可視行頭から始まる選択 → 開始行はマーカーごと削除される", async ({ openNote }) => {
    const page = await openNote({ content: "- item\nxyz" });

    // "- |item" の可視行頭（マーカー直後）〜 "xy|z"（可視オフセット 2）
    await selectMarkdownRange(page, 0, 0, 1, 2);
    await page.keyboard.press("Backspace");

    expect(await getContent(page)).toBe("z");
  });

  test("見出し行が開始行でも同様にマーカーごと削除される", async ({ openNote }) => {
    const page = await openNote({ content: "# head\nxyz" });

    await selectMarkdownRange(page, 0, 0, 1, 3);
    await page.keyboard.press("Backspace");

    expect(await getContent(page)).toBe("");
  });

  test("終了行が可視行頭で終わる選択（内容は 1 文字も選んでいない） → 終了行はマーカーごと丸ごと残る", async ({ openNote }) => {
    const page = await openNote({ content: "abc\n- item" });

    // "abc" 全体 〜 "- |item"（"- item" の可視行頭。内容には触れていない）
    await selectMarkdownRange(page, 0, 0, 1, 0);
    await page.keyboard.press("Backspace");

    expect(await getContent(page)).toBe("- item");
  });

  test("開始行・終了行ともマーカー付きの部分選択（通常の行またぎ削除）は従来どおり動く", async ({ openNote }) => {
    const page = await openNote({ content: "- start line\n- end line" });

    // "- st|art line" 〜 "- end|" line（どちらもマーカーの内側・行末より手前で切れる部分選択）
    await selectMarkdownRange(page, 0, 2, 1, 3);
    await page.keyboard.press("Backspace");

    expect(await getContent(page)).toBe("- st line");
  });
});

test.describe("マーカー付き単一行の全選択削除", () => {
  test("- item を ⌘A → Backspace で全消去される", async ({ openNote }) => {
    const page = await openNote({ content: "- item" });

    await page.keyboard.press("Meta+a");
    await page.keyboard.press("Backspace");

    expect(await getContent(page)).toBe("");
  });

  test("> quote を ⌘A → Backspace で全消去される", async ({ openNote }) => {
    const page = await openNote({ content: "> quote" });

    await page.keyboard.press("Meta+a");
    await page.keyboard.press("Backspace");

    expect(await getContent(page)).toBe("");
  });
});

test.describe("行またぎ選択中の Enter / Shift+Enter", () => {
  test("Enter → 選択範囲を削除したうえで行を分割する", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef" });

    await selectMarkdownRange(page, 0, 1, 1, 2);
    await page.keyboard.press("Enter");

    expect(await getContent(page)).toBe("a\nf");
  });

  test("Shift+Enter → 選択範囲を削除したうえで素の改行だけ入る", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef" });

    await selectMarkdownRange(page, 0, 0, 1, "def".length);
    await page.keyboard.press("Shift+Enter");

    expect(await getContent(page)).toBe("\n");
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

  test("選択の端が装飾の内部に落ちても、クリップボードの内容と削除される可視範囲が一致する", async ({ openNote }) => {
    const page = await openNote({ content: "abc **bold** def\ntail" });

    // 可視 "abc bold def" の 5 = 太字の中身 "o" の直前（raw では "old def" が選択に入る）
    await selectMarkdownRange(page, 0, 5, 1, 2);
    const { notCanceled, plain } = await dispatchCutWithClipboardData(page);

    expect(notCanceled).toBe(false); // preventDefault された
    expect(plain).toBe("old def\nta");
    // 太字は選択が部分的にしか覆っていない（"b" が選択の外）ため、マーカーは保存され
    // 中身の削除範囲だけが取り除かれる（"abc **b" + "**"（保存） + "il"）
    expect(await getContent(page)).toBe("abc **b**il");
  });
});

test.describe("行またぎ選択の Escape", () => {
  test("選択が解除されるだけで、キャレットは立たない", async ({ openNote }) => {
    const page = await openNote({ content: "line1\nline2" });

    await selectMarkdownRange(page, 0, 0, 1, "line2".length);
    await page.keyboard.press("Escape");

    expect(await page.evaluate(() => window.getSelection()!.rangeCount)).toBe(0);
    expect(await getContent(page)).toBe("line1\nline2");
  });
});

test.describe("行またぎ選択の無修飾矢印キー", () => {
  test("←/↑ で選択開始端へキャレットが畳まれる", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef\nghi" });

    await selectMarkdownRange(page, 0, 1, 2, 2);
    await page.keyboard.press("ArrowLeft");

    expect(await page.evaluate(() => window.getSelection()!.isCollapsed)).toBe(true);
    expect(await caretLine(page)).toBe(0);
    expect(await caretRawColumn(page)).toBe(1);
  });

  test("→/↓ で選択終了端へキャレットが畳まれる", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef\nghi" });

    await selectMarkdownRange(page, 0, 1, 2, 2);
    await page.keyboard.press("ArrowRight");

    expect(await page.evaluate(() => window.getSelection()!.isCollapsed)).toBe(true);
    expect(await caretLine(page)).toBe(2);
    expect(await caretRawColumn(page)).toBe(2);
  });
});

test.describe("行またぎ選択中の ⌥Backspace", () => {
  // タイピング・ペーストによる置換は selection-replace-e2e.spec.ts を参照。

  // 選択がある状態の Alt+Backspace は、ブラウザが単語削除ではなく通常の
  // deleteContentBackward（選択の削除）として beforeinput を発火させる。これは他の
  // エディタ（ブラウザの contenteditable 全般）と同じ標準的な挙動で、選択が無いときの
  // 単語削除（deleteWordBackward）は beforeinput ディスパッチャの実装対象外として
  // fail-closed のまま（no-op）
  test("選択がある状態の ⌥Backspace は通常の Backspace と同じく選択範囲を削除する", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef" });

    await selectMarkdownRange(page, 0, 0, 1, "def".length);
    await page.keyboard.press("Alt+Backspace");

    expect(await getContent(page)).toBe("");
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

    expect(await caretLine(page)).toBe(1);
    expect(await caretRawColumn(page)).toBe(2); // "- " の直後（マーカー分の 2 列目）
  });
});

test.describe("マーカー付き行を開始端とする選択の ←/↑ 畳み", () => {
  test("キャレットはマーカー直後（可視位置）に置かれ、行頭には畳まれない", async ({ openNote }) => {
    const page = await openNote({ content: "- item\nxyz" });

    // 0行目の可視オフセット 0（"- " マーカー直後）から始める選択
    await selectMarkdownRange(page, 0, 0, 1, 2);
    await page.keyboard.press("ArrowLeft");

    expect(await caretLine(page)).toBe(0);
    expect(await caretRawColumn(page)).toBe(2); // "- " の直後（マーカー分の 2 列目）
  });
});

test.describe("画像行を含む範囲削除", () => {
  test("削除後に開始行が画像のみの行になっても、画像選択が残り操作不能にならない", async ({ openNote }) => {
    const page = await openNote({ content: `abc\n${IMAGE_LINE}\ndef` });

    await selectMarkdownRange(page, 0, 0, 1, 0);
    await page.keyboard.press("Backspace");

    expect(await getContent(page)).toBe(`${IMAGE_LINE}\ndef`);
    // キャレットも画像選択も無い操作不能状態になっていないこと
    const line = await caretLine(page);
    const selectedImageCount = await page.locator(".img-selected").count();
    expect(line != null || selectedImageCount > 0).toBe(true);
  });

  test("削除範囲外の画像が選択中でも、テキスト範囲の Backspace で表示が壊れない", async ({ openNote }) => {
    const page = await openNote({ content: `${IMAGE_LINE}\nabc\ndef\nghi` });

    // 0行目（画像のみの行）へ placeCaretAtRaw すると selectImage が呼ばれ、画像選択状態になる
    await page.evaluate(
      () => (window as unknown as { placeCaretAtRaw(l: number, c: number | null): void }).placeCaretAtRaw(0, null),
    );
    await expect(page.locator(".img-selected")).toHaveCount(1);

    await selectMarkdownRange(page, 1, 0, 2, "def".length);
    await page.keyboard.press("Backspace");

    expect(await getContent(page)).toBe(`${IMAGE_LINE}\n\nghi`);
    expect(await caretLine(page)).toBe(1);
    // 画像自体は消えておらず、表示も壊れていない
    await expect(page.locator("#markdown-view img")).toHaveCount(1);
  });
});
