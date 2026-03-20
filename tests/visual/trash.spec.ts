import { test, expect } from "./fixtures";

test.describe("trash.html", () => {
  test("empty trash shows message", async ({ trashPage }) => {
    await expect(trashPage.locator(".empty-msg")).toHaveText("ゴミ箱は空です");
    await expect(trashPage).toHaveScreenshot("trash-empty.png");
  });

  test("empty trash shows count (0 / 200)", async ({ trashPage }) => {
    await expect(trashPage.locator("#trash-count")).toHaveText("(0 / 200)");
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

  test("trash with notes shows count (件数 / 200)", async ({ openTrash }) => {
    const page = await openTrash([
      { id: "n1", content: "Note 1", color: "yellow", x: 0, y: 0, width: 280, height: 320, zoom: 100 },
      { id: "n2", content: "Note 2", color: "blue", x: 0, y: 0, width: 280, height: 320, zoom: 100 },
      { id: "n3", content: "Note 3", color: "green", x: 0, y: 0, width: 280, height: 320, zoom: 100 },
    ]);
    await expect(page.locator("#trash-count")).toHaveText("(3 / 200)");
  });
});
