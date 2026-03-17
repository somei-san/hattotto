import { test, expect } from "./fixtures";

const COLORS = ["yellow", "blue", "green", "pink", "purple", "gray"] as const;

for (const color of COLORS) {
  test(`empty note — ${color}`, async ({ openNote }) => {
    const page = await openNote({ color });
    await expect(page).toHaveScreenshot(`note-${color}.png`);
  });
}

test("note with text content", async ({ openNote }) => {
  const page = await openNote({
    color: "yellow",
    content: "これはテストメモです\nHatto-to 付箋アプリ",
  });
  await expect(page).toHaveScreenshot("note-with-text.png");
});

test("color picker open", async ({ notePage }) => {
  await notePage.click("#btn-color");
  await notePage.waitForSelector(".color-picker.open");
  await expect(notePage).toHaveScreenshot("color-picker-open.png");
});
