import { test, expect, enterEdit, getContent } from "./fixtures";

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

  test("Tab がデフォルト動作（フォーカス移動）しないこと", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- item");
    await page.keyboard.press("Tab");

    // 生エディタにまだフォーカスがあること
    const focused = await page.evaluate(() =>
      document.activeElement?.classList.contains("raw-editor")
    );
    expect(focused).toBe(true);
  });
});
