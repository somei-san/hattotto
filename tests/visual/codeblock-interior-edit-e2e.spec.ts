import { test, expect, placeCaret, getContent } from "./fixtures";

// コードブロック（```〜```）内での入力・キャレット配置の回帰テスト。

test.describe("コードブロック内容行への入力", () => {
  test("行の途中への入力はその行だけに反映される", async ({ openNote }) => {
    const page = await openNote({ content: "```\ncode\n```" });
    await placeCaret(page, 1, 2); // "co|de"
    await page.keyboard.type("X", { delay: 10 });
    expect(await getContent(page)).toBe("```\ncoXde\n```\n");
  });

  test("行頭への入力", async ({ openNote }) => {
    const page = await openNote({ content: "```\ncode\n```" });
    await placeCaret(page, 1, 0);
    await page.keyboard.type("X", { delay: 10 });
    expect(await getContent(page)).toBe("```\nXcode\n```\n");
  });

  test("行末への入力", async ({ openNote }) => {
    const page = await openNote({ content: "```\ncode\n```" });
    await placeCaret(page, 1, "code".length);
    await page.keyboard.type("X", { delay: 10 });
    expect(await getContent(page)).toBe("```\ncodeX\n```\n");
  });

  test("空行への入力", async ({ openNote }) => {
    const page = await openNote({ content: "```\n\n```" });
    await placeCaret(page, 1, 0);
    await page.keyboard.type("X", { delay: 10 });
    expect(await getContent(page)).toBe("```\nX\n```\n");
  });

  test("最終内容行の行末で Enter → 空行が見える行として描画され、続けて入力できる", async ({ openNote }) => {
    const page = await openNote({ content: "```\ncode\n```" });
    await placeCaret(page, 1, "code".length);
    await page.keyboard.press("Enter");
    expect(await getContent(page)).toBe("```\ncode\n\n```\n");
    // 末尾の空行は <br> フィラーが行ボックスを確保して描画される
    expect(await page.evaluate(() => document.querySelector("#markdown-view pre.md-codeblock code br") != null)).toBe(true);

    await page.keyboard.type("next", { delay: 10 });
    expect(await getContent(page)).toBe("```\ncode\nnext\n```\n");
  });

  test("Enter で内容行が分割される", async ({ openNote }) => {
    const page = await openNote({ content: "```\nfoo\nbar\n```" });
    await placeCaret(page, 1, "foo".length);
    await page.keyboard.press("Enter");
    expect(await getContent(page)).toBe("```\nfoo\n\nbar\n```\n");
  });

  test("クリックで複数行コードブロックの内部行にキャレットを置いて入力できる", async ({ openNote }) => {
    const page = await openNote({ content: "```\nfoo\nbar\nbaz\n```" });
    const pre = page.locator("#markdown-view pre.md-codeblock");
    const box = await pre.boundingBox();
    await page.mouse.click(box!.x + 5, box!.y + box!.height * 0.5); // 中央付近（2行目）
    await page.keyboard.type("X", { delay: 10 });
    expect(await getContent(page)).toBe("```\nfoo\nXbar\nbaz\n```\n");
  });

  test("ArrowDown でコードブロック内を行送りしてから入力できる", async ({ openNote }) => {
    const page = await openNote({ content: "```\nfoo\nbar\nbaz\n```" });
    await placeCaret(page, 1, 0);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.type("X", { delay: 10 });
    expect(await getContent(page)).toBe("```\nfoo\nXbar\nbaz\n```\n");
  });
});
