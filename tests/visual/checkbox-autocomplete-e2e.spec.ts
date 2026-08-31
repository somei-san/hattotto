import { test, expect, enterEdit, getContent } from "./fixtures";

test.describe("checkbox autocomplete E2E", () => {
  test("typing '- []' autocompletes to '- [ ] '", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- []", { delay: 30 });
    const text = await getContent(page);
    expect(text).toBe("- [ ] ");
  });

  test("typing '- [x]' autocompletes to '- [x] '", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- [x]", { delay: 30 });
    const text = await getContent(page);
    expect(text).toBe("- [x] ");
  });

  test("typing '- [X]' autocompletes to '- [x] '", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- [X]", { delay: 30 });
    const text = await getContent(page);
    expect(text).toBe("- [x] ");
  });

  test("typing '* []' autocompletes to '* [ ] '", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("* []", { delay: 30 });
    const text = await getContent(page);
    expect(text).toBe("* [ ] ");
  });

  test("typing '-[]' autocompletes to '- [ ] '", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("-[]", { delay: 30 });
    const text = await getContent(page);
    expect(text).toBe("- [ ] ");
  });

  test("typing '*[x]' autocompletes to '* [x] '", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("*[x]", { delay: 30 });
    const text = await getContent(page);
    expect(text).toBe("* [x] ");
  });

  test("cursor is placed after autocomplete", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- []", { delay: 30 });
    await page.keyboard.type("task", { delay: 30 });
    const text = await getContent(page);
    expect(text).toBe("- [ ] task");
  });

  test("does not autocomplete on second line without checkbox", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("hello", { delay: 30 });
    const text = await getContent(page);
    expect(text).toBe("hello");
  });

  test("does not autocomplete inside a fenced code block", async ({ openNote }) => {
    const page = await openNote({ content: "```\n\n```" });
    await enterEdit(page, 1);
    await page.keyboard.type("- []", { delay: 30 });
    const text = await getContent(page);
    // 閉じフェンスが最終行になる編集は applyLines が末尾に空行を確保する（ensureTrailingLineAfterClosedFence）
    expect(text).toBe("```\n- []\n```\n");
  });
});
