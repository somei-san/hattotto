import { test, expect, enterEdit, getContent } from "./fixtures";

// トリガーは `]` の直後に打ったスペース。`]` を打った時点では変換せず、その直後にスペースを
// 打った時点で `- []`・`-[x]` 等（CHECKBOX_RE の対象）を `- [ ] `/`- [x] ` へ正規化する。
// 標準記法 `- [ ]`（`[`と`]`の間に既にスペース）は CHECKBOX_RE に一致しないため、この正規化を
// 経由せず、スペースを打った時点でそのまま通常の打鍵として成立する。

test.describe("checkbox autocomplete E2E", () => {
  test("typing '- [] ' autocompletes to '- [ ] '", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- [] ", { delay: 30 });
    const text = await getContent(page);
    expect(text).toBe("- [ ] ");
  });

  test("typing '- [x] ' autocompletes to '- [x] '", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- [x] ", { delay: 30 });
    const text = await getContent(page);
    expect(text).toBe("- [x] ");
  });

  test("typing '- [X] ' autocompletes to '- [x] '", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- [X] ", { delay: 30 });
    const text = await getContent(page);
    expect(text).toBe("- [x] ");
  });

  test("typing '* [] ' autocompletes to '* [ ] '", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("* [] ", { delay: 30 });
    const text = await getContent(page);
    expect(text).toBe("* [ ] ");
  });

  test("typing '-[] ' autocompletes to '- [ ] '", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("-[] ", { delay: 30 });
    const text = await getContent(page);
    expect(text).toBe("- [ ] ");
  });

  test("typing '*[x] ' autocompletes to '* [x] '", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("*[x] ", { delay: 30 });
    const text = await getContent(page);
    expect(text).toBe("* [x] ");
  });

  test("cursor is placed after autocomplete", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- [] ", { delay: 30 });
    await page.keyboard.type("task", { delay: 30 });
    const text = await getContent(page);
    expect(text).toBe("- [ ] task");
  });

  test("does not autocomplete right after ']' (before the trigger space)", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- []", { delay: 30 });
    const text = await getContent(page);
    expect(text).toBe("- []");
  });

  test("'- [ ] ' (already spaced) is not re-normalized by the trigger space", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- [ ] ", { delay: 30 });
    const text = await getContent(page);
    expect(text).toBe("- [ ] ");
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
    await page.keyboard.type("- [] ", { delay: 30 });
    const text = await getContent(page);
    // 閉じフェンスが最終行になる編集は applyLines が末尾に空行を確保する（ensureTrailingLineAfterClosedFence）
    expect(text).toBe("```\n- [] \n```\n");
  });
});
