import { test, expect, enterEdit, getContent } from "./fixtures";

// チェックボックス記法の自動補完（`- []` → `- [ ] ` 等）は beforeinput の編集経路に
// 未実装のため、全テストを fixme にしている
test.describe("checkbox autocomplete E2E", () => {
  test.fixme("typing '- []' autocompletes to '- [ ] '", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- []", { delay: 30 });
    const text = await getContent(page);
    expect(text).toBe("- [ ] ");
  });

  test.fixme("typing '- [x]' autocompletes to '- [x] '", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- [x]", { delay: 30 });
    const text = await getContent(page);
    expect(text).toBe("- [x] ");
  });

  test.fixme("typing '- [X]' autocompletes to '- [x] '", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- [X]", { delay: 30 });
    const text = await getContent(page);
    expect(text).toBe("- [x] ");
  });

  test.fixme("typing '* []' autocompletes to '* [ ] '", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("* []", { delay: 30 });
    const text = await getContent(page);
    expect(text).toBe("* [ ] ");
  });

  test.fixme("typing '-[]' autocompletes to '- [ ] '", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("-[]", { delay: 30 });
    const text = await getContent(page);
    expect(text).toBe("- [ ] ");
  });

  test.fixme("typing '*[x]' autocompletes to '* [x] '", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("*[x]", { delay: 30 });
    const text = await getContent(page);
    expect(text).toBe("* [x] ");
  });

  test.fixme("cursor is placed after autocomplete", async ({ openNote }) => {
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
});
