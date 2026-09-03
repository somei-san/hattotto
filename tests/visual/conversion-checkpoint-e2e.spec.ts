import { test, expect, enterEdit, getContent, commitHistory, placeCaret, waitForReveal, getCaretPosition } from "./fixtures";

// ① は再描画の帰結としての記法変換を受容する（`# ` を打ち終えると見出しに変わる等）。
// ② はその変換を起こした splice の直前で明示的に editHistory.commit するチェックポイントで、
// ⌘Z 1 回が「変換を起こした 1 打鍵」だけを取り消せることを検証する。⌘Z はネイティブメニュー
// 経由（undo-redo-e2e.spec.ts 参照）のため、ここでも window.performUndo/performRedo を直接呼ぶ。

function performUndo(page: import("@playwright/test").Page) {
  return page.evaluate(() => (window as any).performUndo());
}

function performRedo(page: import("@playwright/test").Page) {
  return page.evaluate(() => (window as any).performRedo());
}

test.describe("変換確定チェックポイント", () => {
  test("見出し(# )の変換確定でチェックポイントが入り、undo 1回でリテラルに戻る", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("# ", { delay: 30 });
    await expect.poll(() => getContent(page)).toBe("# ");
    await commitHistory(page);

    await performUndo(page);
    await expect.poll(() => getContent(page)).toBe("#");
    // 変換確定チェックポイントの undo 後は、行末固定ではなく差分位置（"#" の直後）にキャレットが来る
    await expect.poll(() => getCaretPosition(page)).toEqual({ line: 0, col: 1 });

    await performUndo(page);
    await expect.poll(() => getContent(page)).toBe("");
  });

  test("箇条書き(- )の変換確定でチェックポイントが入り、undo 1回でリテラルに戻る", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- ", { delay: 30 });
    await expect.poll(() => getContent(page)).toBe("- ");
    await commitHistory(page);

    await performUndo(page);
    await expect.poll(() => getContent(page)).toBe("-");
  });

  test("順序リスト(1. )の変換確定でチェックポイントが入り、undo 1回でリテラルに戻る", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("1. ", { delay: 30 });
    await expect.poll(() => getContent(page)).toBe("1. ");
    await commitHistory(page);

    await performUndo(page);
    await expect.poll(() => getContent(page)).toBe("1.");
  });

  test("チェックボックス補完(- [] + スペース → - [ ] )の変換確定でチェックポイントが入り、undo 1回でスペース打鍵前に戻る", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- []", { delay: 30 });
    // トリガーはスペース。"]" を打った時点ではまだ変換されない
    await expect.poll(() => getContent(page)).toBe("- []");
    await page.keyboard.type(" ", { delay: 30 });
    await expect.poll(() => getContent(page)).toBe("- [ ] ");
    await commitHistory(page);

    // トリガーのスペースを打つ直前（"- []"、まだ箇条書きのまま）に 1 回で戻る
    await performUndo(page);
    await expect.poll(() => getContent(page)).toBe("- []");
    // 削除された "]" の手前ではなく、"]" の直後（col 4）にキャレットが来る
    await expect.poll(() => getCaretPosition(page)).toEqual({ line: 0, col: 4 });

    // 補完前の "- " 成立の打鍵にも独立したチェックポイントが残っている
    await performUndo(page);
    await expect.poll(() => getContent(page)).toBe("-");
  });

  test("太字(**bold**)の閉じ確定でチェックポイントが入り、undo 1回で **bold* に戻る", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    // 打ち切り（デバウンス窓を跨がず連続入力）で "**bold**" まで一気に打つ
    await page.keyboard.type("**bold**", { delay: 30 });
    await expect.poll(() => getContent(page)).toBe("**bold**");
    await commitHistory(page);

    await performUndo(page);
    await expect.poll(() => getContent(page)).toBe("**bold*");
  });

  test("変換を含まない連続タイピングはデバウンス単位のまま（回帰）", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("hello world", { delay: 30 });
    await expect.poll(() => getContent(page)).toBe("hello world");
    await commitHistory(page);

    // 記法変換を含まないので、チェックポイントは増えず 1 回の undo で空に戻る
    await performUndo(page);
    await expect.poll(() => getContent(page)).toBe("");
  });

  test("変換チェックポイントの undo を redo すると変換後の状態に戻る", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("# ", { delay: 30 });
    await expect.poll(() => getContent(page)).toBe("# ");
    await commitHistory(page);

    await performUndo(page);
    await expect.poll(() => getContent(page)).toBe("#");

    await performRedo(page);
    await expect.poll(() => getContent(page)).toBe("# ");
  });
});

// checkpointConversion は classifyLine・inlineSegments という描画側の判定をそのまま使うため、
// フェンス内容行に対して素通しで呼ぶと、コードとして書いた記法（`- ` や `` `a` ``）まで
// ブロック/装飾の新規成立として誤検出する。maybeAutocompleteCheckbox と同じ findBlock 判定で
// フェンス内容行を対象外にし、コード内のタイピングが undo チェックポイントを増やさないことを
// 検証する。
test.describe("フェンス内容行での誤発動ガード", () => {
  test("コードブロック内容行の `- ` はチェックポイントを作らず undo は1手で戻る", async ({ openNote }) => {
    const page = await openNote({ content: "```\n\n```" });
    await placeCaret(page, 1, 0);
    await page.keyboard.type("- ", { delay: 30 });
    await expect.poll(() => getContent(page)).toBe("```\n- \n```\n");
    await commitHistory(page);

    await performUndo(page);
    await expect.poll(() => getContent(page)).toBe("```\n\n```");
  });

  test("コードブロック内容行の `` `a` `` はチェックポイントを作らず undo は1手で戻る", async ({ openNote }) => {
    const page = await openNote({ content: "```\n\n```" });
    await placeCaret(page, 1, 0);
    await page.keyboard.type("`a`", { delay: 30 });
    await expect.poll(() => getContent(page)).toBe("```\n`a`\n```\n");
    await commitHistory(page);

    await performUndo(page);
    await expect.poll(() => getContent(page)).toBe("```\n\n```");
  });
});

// checkpointConversion は 1 文字挿入ごとに呼ばれるが、実際にチェックポイントを打つのは
// lineConversionOccurred が真のときだけ。変換確定後の平文タイピングや、reveal 中（装飾内部に
// キャレットがある間）の追記では新規成立が起きないため、打鍵ごとにチェックポイントが増えず
// undo の粒度はデバウンス単位のまま保たれることを検証する（回帰）。
test.describe("変換確定後の連続タイピングでチェックポイントが増えない", () => {
  test("**bold** 確定後の平文タイピングは1手にまとまる", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("**bold**", { delay: 30 });
    await commitHistory(page); // 変換確定の直後で一度確定させ、ここを手の境界にする
    await expect.poll(() => getContent(page)).toBe("**bold**");

    await page.keyboard.type(" and more", { delay: 30 });
    await expect.poll(() => getContent(page)).toBe("**bold** and more");
    await commitHistory(page);

    await performUndo(page);
    await expect.poll(() => getContent(page)).toBe("**bold**");
  });

  test("reveal 中（装飾内部にキャレット）での追記は1手にまとまる", async ({ openNote }) => {
    const page = await openNote({ content: "**bold**" });
    await placeCaret(page, 0, 4); // "**bo|ld**" — bold 装飾の内部
    await waitForReveal(page, { line: 0, start: 0, end: 8 });

    await page.keyboard.type("xyz", { delay: 30 });
    await expect.poll(() => getContent(page)).toBe("**boxyzld**");
    await commitHistory(page);

    await performUndo(page);
    await expect.poll(() => getContent(page)).toBe("**bold**");
  });
});
