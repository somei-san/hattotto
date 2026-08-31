import { test, expect, placeCaret, getContent, selectMarkdownRange, waitForReveal } from "./fixtures";

// collapsed キャレット（選択ではなく一点）での Backspace/Delete。deleteAdjacentVisibleChar
// （adjacentVisibleCharRawRange 経由）が「direction 側に隣接する可視 1 書記素ぶんの raw 範囲」を
// 求めて削除する。

const IMAGE_PATH = "images/00000000-0000-4000-8000-000000000001.png";
const IMAGE_LINE = `![](${IMAGE_PATH})`;

/** 現在のキャレットが属する行番号（data-line）。無ければ -1。 */
function caretLine(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const node = window.getSelection()?.anchorNode ?? null;
    const el = node instanceof Element ? node : node?.parentElement;
    const line = el?.closest("[data-line]")?.getAttribute("data-line");
    return line == null ? -1 : Number(line);
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

test.describe("collapsed キャレットの Backspace/Delete", () => {
  test("画像記法の直後で Backspace → 画像の raw 記法全体が消える（可視長 0 セグメント）", async ({ openNote }) => {
    const page = await openNote({ content: `a${IMAGE_LINE}` });

    await placeCaret(page, 0); // 行末（画像の直後）
    await page.keyboard.press("Backspace");

    expect(await getContent(page)).toBe("a");
  });

  test("画像記法の直前で Delete → 画像の raw 記法全体が消える（可視長 0 セグメント）", async ({ openNote }) => {
    const page = await openNote({ content: `a${IMAGE_LINE}` });

    await placeCaret(page, 0, 1); // "a" の直後・画像記法の直前
    await page.keyboard.press("Delete");

    expect(await getContent(page)).toBe("a");
  });

  test("太字装飾の可視末尾で Backspace → インライン生表示（reveal）で境界がマーカー込みの raw 1 文字削除になる", async ({ openNote }) => {
    const page = await openNote({ content: "a**b**c" });

    // 可視 "abc" のうち "b" の直後（装飾の可視末尾）へキャレットを置く。この位置は reveal の
    // 境界規約（可視末尾を含む）に触れるため、装飾全体が生 raw（"**b**"）表示になり、
    // Backspace は可視 = raw が 1:1 の状態で直前の raw 1 文字（閉じマーカーの 1 文字目）を消す。
    // 同じ可視末尾への「入力」はマーカーの外（装飾の後続プレーン部分）に入るのに対し Backspace は
    // マーカー自体を 1 文字削除するが、これは reveal 中はマーカーが見える raw を直接編集する仕様
    // として非対称のまま意図的に許容している
    await selectMarkdownRange(page, 0, 2, 0, 2);
    await waitForReveal(page, { line: 0, start: 1, end: 6 });
    await page.keyboard.press("Backspace");

    expect(await getContent(page)).toBe("a**b*c");
  });

  test("ZWJ 絵文字（結合書記素）の直後で Backspace → 書記素 1 つ全体が消える", async ({ openNote }) => {
    const familyEmoji = "\u{1F468}‍\u{1F469}‍\u{1F467}"; // 👨‍👩‍👧
    const page = await openNote({ content: familyEmoji });

    await placeCaret(page, 0); // 行末
    await page.keyboard.press("Backspace");

    expect(await getContent(page)).toBe("");
  });

  // フェンス内容行は raw が可視テキストそのまま（マーカーという概念が無い）で、行頭の空白は
  // インデントではなく実コードの一部。markerLength をそのまま適用すると空白をマーカー扱いして
  // 削除範囲からずれてしまうため、lineStartColumn（フェンス内容行は常に 0）で判定する。
  // 閉じフェンスが最終行のまま残る編集なので、applyLines の末尾空行正規化で1行足される
  // （コードブロックの下に入力する場所を常に確保する仕様）
  test("フェンス内容行の行頭空白は Backspace で普通に 1 文字ずつ消える", async ({ openNote }) => {
    const page = await openNote({ content: "```\n    foo\n```" });
    await placeCaret(page, 1, 2); // "    foo" の 2 文字目と 3 文字目の間
    await page.keyboard.press("Backspace");
    expect(await getContent(page)).toBe("```\n   foo\n```\n");
  });

  test("フェンス内容行の行頭空白は Delete でも普通に 1 文字ずつ消える", async ({ openNote }) => {
    const page = await openNote({ content: "```\n    foo\n```" });
    await placeCaret(page, 1, 2); // "    foo" の 2 文字目と 3 文字目の間
    await page.keyboard.press("Delete");
    expect(await getContent(page)).toBe("```\n   foo\n```\n");
  });
});

// 可視行頭（raw col === markerLength）での Backspace。backspaceAtLineStart が段階的に解除する:
// 1) マーカーあり → マーカーだけ除去（インデント維持） 2) マーカーなしでインデントあり →
// インデント全除去 3) どちらも無し → 前行と結合。各段は 1 splice（undo 1 手）。

test.describe("行頭 Backspace の段階解除", () => {
  test("見出し「# 」→ マーカーだけ除去", async ({ openNote }) => {
    const page = await openNote({ content: "# Heading" });
    await placeCaret(page, 0, "# ".length);
    await page.keyboard.press("Backspace");
    expect(await getContent(page)).toBe("Heading");
  });

  test("引用「> 」→ マーカーだけ除去", async ({ openNote }) => {
    const page = await openNote({ content: "> quote" });
    await placeCaret(page, 0, "> ".length);
    await page.keyboard.press("Backspace");
    expect(await getContent(page)).toBe("quote");
  });

  test("チェックボックス「- [ ] 」→ マーカーだけ除去", async ({ openNote }) => {
    const page = await openNote({ content: "- [ ] task" });
    await placeCaret(page, 0, "- [ ] ".length);
    await page.keyboard.press("Backspace");
    expect(await getContent(page)).toBe("task");
  });

  test("インデント付きリスト「  - 」→ マーカー除去 → インデント除去 → 前行と結合（3 段）", async ({ openNote }) => {
    const page = await openNote({ content: "before\n  - item" });

    await placeCaret(page, 1, "  - ".length); // 内容（"item"）の先頭
    await page.keyboard.press("Backspace"); // 1 段目: マーカーだけ除去
    expect(await getContent(page)).toBe("before\n  item");

    await page.keyboard.press("Backspace"); // 2 段目: インデント除去
    expect(await getContent(page)).toBe("before\nitem");

    await page.keyboard.press("Backspace"); // 3 段目: 前行と結合、キャレットは前行末尾へ
    expect(await getContent(page)).toBe("beforeitem");
    expect(await caretLine(page)).toBe(0);
    expect(await caretRawColumn(page)).toBe("before".length);
  });

  test("各段のあいだで保存デバウンス窓をまたぐと、それぞれ独立した undo 1 手になる", async ({ openNote }) => {
    const page = await openNote({ content: "before\n  - item" });

    await placeCaret(page, 1, "  - ".length);
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(400); // 各段のあいだで保存を確定させ、history へ別の手として積ませる
    expect(await getContent(page)).toBe("before\n  item");

    await page.keyboard.press("Backspace");
    await page.waitForTimeout(400);
    expect(await getContent(page)).toBe("before\nitem");

    await page.keyboard.press("Backspace");
    await page.waitForTimeout(400);
    expect(await getContent(page)).toBe("beforeitem");

    await page.evaluate(() => (window as unknown as { performUndo(): void }).performUndo());
    expect(await getContent(page)).toBe("before\nitem");

    await page.evaluate(() => (window as unknown as { performUndo(): void }).performUndo());
    expect(await getContent(page)).toBe("before\n  item");

    await page.evaluate(() => (window as unknown as { performUndo(): void }).performUndo());
    expect(await getContent(page)).toBe("before\n  - item");
  });

  test("先頭行でのマーカー・インデントなし Backspace → 結合先が無く no-op", async ({ openNote }) => {
    const page = await openNote({ content: "item" });
    await placeCaret(page, 0, 0);
    await page.keyboard.press("Backspace");
    expect(await getContent(page)).toBe("item");
  });

  test("前行がコードフェンスの区切り（```）→ 結合すると記法が壊れるため no-op", async ({ openNote }) => {
    const page = await openNote({ content: "```\ncode\n```\nafter" });
    await placeCaret(page, 3, 0);
    await page.keyboard.press("Backspace");
    expect(await getContent(page)).toBe("```\ncode\n```\nafter");
  });

  test("コードブロックの最初の内容行の行頭 → ブロック解除（フェンス 2 行が消え内容が残る）", async ({ openNote }) => {
    const page = await openNote({ content: "before\n```\ncode\nmore\n```\nafter" });
    await placeCaret(page, 2, 0); // "code" の行頭
    await page.keyboard.press("Backspace");
    expect(await getContent(page)).toBe("before\ncode\nmore\nafter");
    expect(await caretLine(page)).toBe(1); // "code"（プレーンテキスト化）の行頭に残る
    expect(await caretRawColumn(page)).toBe(0);
  });

  test("空のコードブロックでも解除できる（空 1 行になる）", async ({ openNote }) => {
    const page = await openNote({ content: "```\n\n```" });
    await placeCaret(page, 1, 0);
    await page.keyboard.press("Backspace");
    expect(await getContent(page)).toBe("");
  });

  test("ブロック解除は undo 1 手で元のコードブロックに戻る", async ({ openNote }) => {
    const page = await openNote({ content: "```\ncode\n```" });
    await placeCaret(page, 1, 0);
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(400); // 保存デバウンスを確定させ history へ積ませる
    expect(await getContent(page)).toBe("code");

    await page.evaluate(() => (window as unknown as { performUndo(): void }).performUndo());
    expect(await getContent(page)).toBe("```\ncode\n```");
  });

  test("2 行目以降の内容行の行頭 Backspace は前の内容行との結合のまま（解除しない）", async ({ openNote }) => {
    const page = await openNote({ content: "```\nfoo\nbar\n```" });
    await placeCaret(page, 2, 0); // "bar" の行頭
    await page.keyboard.press("Backspace");
    expect(await getContent(page)).toBe("```\nfoobar\n```\n");
  });

  test("前行が画像のみの行 → 結合すると記法が壊れるため no-op", async ({ openNote }) => {
    const page = await openNote({ content: `${IMAGE_LINE}\nafter` });
    await placeCaret(page, 1, 0);
    await page.keyboard.press("Backspace");
    expect(await getContent(page)).toBe(`${IMAGE_LINE}\nafter`);
  });
});

// 行末（raw col === 行の長さ）での Delete。deleteAtLineEnd が次行のマーカーを剥がして
// 現在行へ連結する（1 段のみ）。

test.describe("行末 Delete のマーカー剥がし連結", () => {
  test("次行がリスト → マーカーを剥がして連結、キャレットは結合点に残る", async ({ openNote }) => {
    const page = await openNote({ content: "before\n- item" });
    await placeCaret(page, 0, null); // "before" の行末
    await page.keyboard.press("Delete");
    expect(await getContent(page)).toBe("beforeitem");
    expect(await caretLine(page)).toBe(0);
    expect(await caretRawColumn(page)).toBe("before".length);
  });

  test("次行が見出し → マーカーを剥がして連結、undo 1 手で戻る", async ({ openNote }) => {
    const page = await openNote({ content: "before\n# Heading" });
    await placeCaret(page, 0, null);
    await page.keyboard.press("Delete");
    await page.waitForTimeout(400);
    expect(await getContent(page)).toBe("beforeHeading");

    await page.evaluate(() => (window as unknown as { performUndo(): void }).performUndo());
    expect(await getContent(page)).toBe("before\n# Heading");
  });

  test("最終行での Delete → 結合先が無く no-op", async ({ openNote }) => {
    const page = await openNote({ content: "only" });
    await placeCaret(page, 0, null);
    await page.keyboard.press("Delete");
    expect(await getContent(page)).toBe("only");
  });

  test("次行がコードフェンスの区切り（```）→ 結合すると記法が壊れるため no-op", async ({ openNote }) => {
    const page = await openNote({ content: "before\n```\ncode\n```" });
    await placeCaret(page, 0, null);
    await page.keyboard.press("Delete");
    expect(await getContent(page)).toBe("before\n```\ncode\n```");
  });

  test("次行が画像のみの行 → 結合すると記法が壊れるため no-op", async ({ openNote }) => {
    const page = await openNote({ content: `before\n${IMAGE_LINE}` });
    await placeCaret(page, 0, null);
    await page.keyboard.press("Delete");
    expect(await getContent(page)).toBe(`before\n${IMAGE_LINE}`);
  });
});
