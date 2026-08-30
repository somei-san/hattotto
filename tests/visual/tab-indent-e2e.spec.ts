import { test, expect, enterEdit, getContent } from "./fixtures";

// Tab/Shift+Tab によるインデントは beforeinput の編集経路に未実装で、ネイティブの
// 既定動作（フォーカス移動）に任せているため、全テストを fixme にしている
test.describe("Tab/Shift+Tab インデント", () => {
  test.fixme("- item にカーソルを置いてTab → 先頭に2スペースが追加", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- item");
    await page.keyboard.press("Tab");

    expect(await getContent(page)).toContain("  - item");
  });

  test.fixme("  - item にカーソルを置いてShift+Tab → 先頭の2スペースが除去", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("  - item");

    await page.keyboard.down("Shift");
    await page.keyboard.press("Tab");
    await page.keyboard.up("Shift");

    expect(await getContent(page)).toBe("- item");
  });

});
