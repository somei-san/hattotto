import { test, expect } from "./fixtures";

test.describe("trash.html", () => {
  test("empty trash shows message", async ({ trashPage }) => {
    await expect(trashPage.locator(".empty-msg")).toHaveText("ゴミ箱は空です");
    await expect(trashPage).toHaveScreenshot("trash-empty.png");
  });

  test("trash with 2 notes shows list", async ({ openTrash }) => {
    const page = await openTrash([
      { id: "n1", content: "First note content", color: "yellow", x: 0, y: 0, width: 280, height: 320, zoom: 100 },
      { id: "n2", content: "Second note content", color: "blue", x: 0, y: 0, width: 280, height: 320, zoom: 100 },
    ]);
    await expect(page.locator(".item")).toHaveCount(2);
    await expect(page.locator(".item-color")).toHaveCount(2);
    await expect(page.locator(".item-preview").first()).toBeVisible();
    await expect(page).toHaveScreenshot("trash-with-notes.png");
  });
});
