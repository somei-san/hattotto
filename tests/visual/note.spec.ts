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

test("note — markdown preview", async ({ openNote }) => {
  const page = await openNote({
    color: "yellow",
    content: "# タイトル\n## サブ見出し\n\n- りんご\n- みかん\n\n- [ ] 未完了タスク\n- [x] 完了タスク",
  });
  await expect(page).toHaveScreenshot("note-markdown.png");
});

test("note — markdown extended", async ({ openNote }) => {
  const page = await openNote({
    color: "yellow",
    content: "**太字** と *斜体* と ~~取り消し~~\n`inline code` テスト\n\n> 引用テキスト\n\n1. 番号リスト1\n2. 番号リスト2\n\n---\n\n[リンク](https://example.com)",
  });
  await expect(page).toHaveScreenshot("note-markdown-extended.png");
});

test("note — markdown fenced code block", async ({ openNote }) => {
  const page = await openNote({
    color: "yellow",
    content: "# コードブロック\n\n```js\nconst x = 1;\nif (x > 0) {\n  console.log(\"hello\");\n}\n```\n\n通常テキスト\n\n```\n# これは見出しではない\n**太字ではない**\n```",
  });
  await expect(page).toHaveScreenshot("note-markdown-codeblock.png");
});

test("color picker open", async ({ notePage }) => {
  await notePage.click("#btn-color");
  await notePage.waitForSelector(".color-picker.open");
  await expect(notePage).toHaveScreenshot("color-picker-open.png");
});

test("note — opacity 50%", async ({ openNote }) => {
  const page = await openNote({}, { opacity: 50 });
  await expect(page).toHaveScreenshot("note-opacity-50.png");
});

test("note — checkbox short text", async ({ openNote }) => {
  const page = await openNote({
    color: "yellow",
    content: "- [ ] 短いタスク\n- [x] 完了タスク",
  });
  await expect(page).toHaveScreenshot("note-checkbox-short.png");
});

test("note — checkbox long text", async ({ openNote }) => {
  const page = await openNote({
    color: "yellow",
    content: "- [ ] 長いチェックボックス長いチェックボックス長いチェックボックス長いチェックボックス長いチェックボックス",
  });
  await expect(page).toHaveScreenshot("note-checkbox-long.png");
});

test("note — bullet vs checkbox comparison", async ({ openNote }) => {
  const page = await openNote({
    color: "yellow",
    content: "- 箇条書きテキスト\n- [ ] チェックボックステキスト",
  });
  await expect(page).toHaveScreenshot("note-bullet-vs-checkbox.png");
});
