import { test, expect, enterEdit, getContent, placeCaret, selectMarkdownRange, commitHistory } from "./fixtures";

// Enter による行分割・リスト自動継続（beforeinput の insertParagraph）。collapsed キャレットは
// 装飾記法・行頭マーカーの内部を指せない（visibleOffsetFromRawOffset の境界規約）ため、
// 「マーカーより手前で Enter」は collapsed 経路では起こりえない（splitLineAt に手前判定の
// 分岐が無いのはそのため）。ただし非 collapsed（選択）経路は別で、可視行頭を含む選択からの
// Enter はマーカーを巻き込む。
test.describe("Markdown autocontinue E2E", () => {
  // ── Bullet list auto-continue ───────────────────────────
  test("- item → Enter inserts '- ' prefix", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- item1");
    await page.keyboard.press("Enter");
    const text = await getContent(page);
    expect(text).toContain("- item1\n- ");
  });

  test("* item → Enter inserts '* ' prefix", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("* item1");
    await page.keyboard.press("Enter");
    const text = await getContent(page);
    expect(text).toContain("* item1\n* ");
  });

  test("1. item → Enter inserts '2. ' prefix", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("1. item1");
    await page.keyboard.press("Enter");
    const text = await getContent(page);
    expect(text).toContain("1. item1\n2. ");
  });

  test("> quote → Enter inserts '> ' prefix", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("> quote");
    await page.keyboard.press("Enter");
    const text = await getContent(page);
    expect(text).toContain("> quote\n> ");
  });

  test("- [ ] task → Enter inserts '- [ ] ' prefix", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- [ ] task");
    await page.keyboard.press("Enter");
    const text = await getContent(page);
    expect(text).toContain("- [ ] task\n- [ ] ");
  });

  // ── Empty list item cancellation ────────────────────────
  test("empty bullet '- ' + Enter cancels the list", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- item1");
    await page.keyboard.press("Enter");
    // Now we have "- item1\n- ", press Enter again on the empty bullet
    await commitHistory(page); // 直前の Enter を確定させ、undo の手を分ける
    await page.keyboard.press("Enter");
    const text = await getContent(page);
    // The empty "- " should be removed
    expect(text).not.toMatch(/\n- \n/);
    expect(text).not.toMatch(/\n- $/);

    // マーカー解除は undo 1 手で「- 」の空リスト項目に戻る
    await commitHistory(page);
    await page.evaluate(() => (window as unknown as { performUndo(): void }).performUndo());
    expect(await getContent(page)).toBe("- item1\n- ");
  });

  // ── Plain text does not trigger ─────────────────────────
  test("plain text → Enter does not insert prefix", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("hello world");
    await page.keyboard.press("Enter");
    const text = await getContent(page);
    // Should just have a newline, no prefix
    expect(text).toContain("hello world\n");
    expect(text).not.toMatch(/hello world\n[-*>]/);
    expect(text).not.toMatch(/hello world\n\d+\./);
  });

  // ── Indented checkbox auto-continue ────────────────────
  test("indented '  - [ ] task' → Enter inserts '  - [ ] ' prefix", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("  - [ ] task");
    await page.keyboard.press("Enter");
    const text = await getContent(page);
    expect(text).toContain("  - [ ] task\n  - [ ] ");
  });

  test("indented '  - item' → Enter inserts '  - ' prefix", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("  - item1");
    await page.keyboard.press("Enter");
    const text = await getContent(page);
    expect(text).toContain("  - item1\n  - ");
  });

  test("indented '  1. item' → Enter inserts '  2. ' prefix", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("  1. item1");
    await page.keyboard.press("Enter");
    const text = await getContent(page);
    expect(text).toContain("  1. item1\n  2. ");
  });

  // ── Enter at beginning/middle of line ─────────────────
  test("Enter at middle of '- hello world' splits and continues", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- hello world");
    // Move caret to middle (after "hello")
    for (let i = 0; i < " world".length; i++) {
      await page.keyboard.press("ArrowLeft");
    }
    await page.keyboard.press("Enter");
    const text = await getContent(page);
    // Should split: "- hello\n- world"
    expect(text).toContain("- hello\n- world");
  });

  test("Enter at beginning of '- item' inserts prefix before content", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- item");
    // Move caret to right after "- " (beginning of content)
    for (let i = 0; i < "item".length; i++) {
      await page.keyboard.press("ArrowLeft");
    }
    await page.keyboard.press("Enter");
    const text = await getContent(page);
    // Should have "- \n- item"
    expect(text).toContain("- \n- item");
  });

  // resolveSelectionBounds は「選択の開始点の可視オフセットが 0（マーカー直後）」の非 collapsed
  // 選択を、削除範囲としてマーカー込みの raw col 0 へ正規化する（backspaceAtLineStart 相当の
  // 意図）。splitLineAt はこの正規化済み bounds をそのまま使うため、可視行頭を含む選択からの
  // Enter は before にマーカーが残らず、getAutoPrefix も無マーカーの行と判定して継続しない
  test("可視行頭を含む選択からの Enter → マーカーごと失われ、素の空行 2 つになる", async ({ openNote }) => {
    const page = await openNote({ content: "- item" });
    await selectMarkdownRange(page, 0, 0, 0, "item".length); // マーカー直後〜"item" 末尾
    await page.keyboard.press("Enter");
    expect(await getContent(page)).toBe("\n");
  });

  // ── フェンス内 Enter は素の改行のみ（自動継続なし） ─────────
  // 閉じフェンスが最終行のまま残る編集なので、applyLines の末尾空行正規化で1行足される
  // （コードブロックの下に入力する場所を常に確保する仕様）
  test("コードフェンス内で Enter → 自動継続せず素の改行だけ入る、保存を確定させると undo 1 手で戻る", async ({ openNote }) => {
    const page = await openNote({ content: "```\n- item\n```" });
    await placeCaret(page, 1, "- item".length);
    await page.keyboard.press("Enter");
    await commitHistory(page);
    expect(await getContent(page)).toBe("```\n- item\n\n```\n");

    await page.evaluate(() => (window as unknown as { performUndo(): void }).performUndo());
    expect(await getContent(page)).toBe("```\n- item\n```");
  });

  // ── 自動挿入は 1 回の Enter で 1 回だけ ──────────────────
  test("1 回の Enter で挿入されるプレフィックスは 1 つだけ", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- item");
    await page.keyboard.press("Enter");
    const text = await getContent(page);
    const prefixCount = (text.match(/\n- /g) || []).length;
    expect(prefixCount).toBe(1);
  });

  // ── undo で 1 手に戻る（保存を確定させた場合） ─────────
  test("Enter の自動継続は保存を確定させると undo 1 手で元の 1 行に戻る", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- item1");
    // タイピングの確定を待ってから Enter を押す。待たずに続けて押すと同じ commit に
    // 収まり、undo が「- item1」の手前（空）まで一気に戻ってしまう
    await commitHistory(page);
    await page.keyboard.press("Enter");
    await commitHistory(page);
    expect(await getContent(page)).toContain("- item1\n- ");

    await page.evaluate(() => (window as unknown as { performUndo(): void }).performUndo());
    expect(await getContent(page)).toBe("- item1");
  });

  // ── 空の順序リスト行への insertText ──────────────────────
  test("空の順序リスト行「1. 」の行末で入力 → 内容が入る", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("1. ");
    await page.keyboard.type("a");
    const text = await getContent(page);
    expect(text).toBe("1. a");
  });
});
