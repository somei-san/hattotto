import { test, expect, enterEdit, getContent, selectMarkdownRange } from "./fixtures";

test.describe("Tab/Shift+Tab インデント", () => {
  test("- item にカーソルを置いてTab → 先頭に2スペースが追加", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- item");
    await page.keyboard.press("Tab");

    expect(await getContent(page)).toContain("  - item");
  });

  test("  - item にカーソルを置いてShift+Tab → 先頭の2スペースが除去", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("  - item");

    await page.keyboard.down("Shift");
    await page.keyboard.press("Tab");
    await page.keyboard.up("Shift");

    expect(await getContent(page)).toBe("- item");
  });

  test("複数行選択でTab → 選択が触れているすべての行が字下げされる", async ({ openNote }) => {
    const page = await openNote({ content: "- A\n- B\n- C" });
    await selectMarkdownRange(page, 0, 0, 2, "C".length);
    await page.keyboard.press("Tab");

    expect(await getContent(page)).toBe("  - A\n  - B\n  - C");
  });

  test("複数行選択でShift+Tab → 選択が触れているすべての行が字下げ解除される", async ({ openNote }) => {
    const page = await openNote({ content: "  - A\n  - B\n- C" });
    await selectMarkdownRange(page, 0, 0, 2, "C".length);
    await page.keyboard.down("Shift");
    await page.keyboard.press("Tab");
    await page.keyboard.up("Shift");

    expect(await getContent(page)).toBe("- A\n- B\n- C");
  });

  test("複数行選択でTabを2連打 → 選択が保たれ2段字下げされる（先頭行だけに畳まれない）", async ({ openNote }) => {
    const page = await openNote({ content: "- A\n- B\n- C" });
    await selectMarkdownRange(page, 0, 0, 2, "C".length);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");

    expect(await getContent(page)).toBe("    - A\n    - B\n    - C");
  });

  test("装飾の内部から始まる複数行選択でTabを2連打 → reveal 再描画を挟んでも選択が保たれ2段字下げされる", async ({ openNote }) => {
    const page = await openNote({ content: "**bold** A\nB\nC" });
    // "bold" の途中（可視オフセット 2）〜 3行目末尾を選択する。選択開始点が装飾の内部にあると
    // indent 後のキャレット位置が reveal 対象になり、selectionchange が revealState クリアの
    // ための再描画を挟む（非選択の内容だけの選択ではこの経路を通らない）
    await selectMarkdownRange(page, 0, 2, 2, "C".length);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");

    expect(await getContent(page)).toBe("    **bold** A\n    B\n    C");
  });
});
