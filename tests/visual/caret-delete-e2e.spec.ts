import { test, expect, placeCaret, getContent, selectMarkdownRange } from "./fixtures";

// collapsed キャレット（選択ではなく一点）での Backspace/Delete。deleteAdjacentVisibleChar
// （adjacentVisibleCharRawRange 経由）が「direction 側に隣接する可視 1 書記素ぶんの raw 範囲」を
// 求めて削除する。

const IMAGE_PATH = "images/00000000-0000-4000-8000-000000000001.png";
const IMAGE_LINE = `![](${IMAGE_PATH})`;

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

  test("太字装飾内部の可視文字直後で Backspace → 装飾内の raw 1 文字だけが消える（空マーカー正規化は未実装）", async ({ openNote }) => {
    const page = await openNote({ content: "a**b**c" });

    // 可視 "abc" のうち "b" の直後（装飾の可視末尾直前）へキャレットを置く
    await selectMarkdownRange(page, 0, 2, 0, 2);
    await page.keyboard.press("Backspace");

    expect(await getContent(page)).toBe("a****c");
  });

  test("ZWJ 絵文字（結合書記素）の直後で Backspace → 書記素 1 つ全体が消える", async ({ openNote }) => {
    const familyEmoji = "\u{1F468}‍\u{1F469}‍\u{1F467}"; // 👨‍👩‍👧
    const page = await openNote({ content: familyEmoji });

    await placeCaret(page, 0); // 行末
    await page.keyboard.press("Backspace");

    expect(await getContent(page)).toBe("");
  });
});
