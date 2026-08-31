import { test, expect, placeCaret, getContent } from "./fixtures";

// 装飾（**bold** 等）の可視文字内部への挿入は charMap（src/markdown.js の inlineSegments）で
// raw 位置へ厳密対応し、装飾が外れないことを確認する回帰テスト。境界規約により、可視末尾
// ちょうど（閉じマーカーの直前）への挿入は仕様どおり装飾の外側になる（このファイルでは対象外。
// 装飾の「内部」への挿入だけを検証する）。

test.describe("装飾の可視文字内部への挿入で装飾が維持される", () => {
  test("行全体が太字: bo|ld への挿入は太字を維持する", async ({ openNote }) => {
    const page = await openNote({ content: "**bold**" });
    await placeCaret(page, 0, 4); // "**bo|ld**"
    await page.keyboard.type("X", { delay: 10 });
    expect(await getContent(page)).toBe("**boXld**");
    const strong = await page.evaluate(() => document.querySelector("#markdown-view strong")?.textContent);
    expect(strong).toBe("boXld");
  });

  test("文中の太字: pre **bo|ld** post への挿入は太字を維持する", async ({ openNote }) => {
    const page = await openNote({ content: "pre **bold** post" });
    await placeCaret(page, 0, 8); // "pre **bo|ld** post"
    await page.keyboard.type("X", { delay: 10 });
    expect(await getContent(page)).toBe("pre **boXld** post");
  });

  test("リスト項目内の太字: - **bo|ld** item への挿入は太字を維持する", async ({ openNote }) => {
    const page = await openNote({ content: "- **bold** item" });
    await placeCaret(page, 0, 6); // "- **bo|ld** item"
    await page.keyboard.type("X", { delay: 10 });
    expect(await getContent(page)).toBe("- **boXld** item");
  });

  test("クリックで装飾内部にキャレットを置いても太字を維持する", async ({ openNote }) => {
    const page = await openNote({ content: "pre **bold** post" });
    const strong = page.locator("#markdown-view strong");
    const box = await strong.boundingBox();
    await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height / 2);
    await page.keyboard.type("X", { delay: 10 });
    expect(await getContent(page)).toBe("pre **boXld** post");
  });

  test("IME 確定（compositionend）で装飾内部に文字を挿入しても太字を維持する", async ({ openNote }) => {
    const page = await openNote({ content: "pre **bold** post" });
    await placeCaret(page, 0, 8); // "pre **bo|ld** post"
    await page.evaluate(() => {
      const mdView = document.getElementById("markdown-view")!;
      mdView.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
      mdView.dispatchEvent(new CompositionEvent("compositionend", { data: "あ" }));
    });
    expect(await getContent(page)).toBe("pre **boあld** post");
  });

  test("文中の斜字（*italic*）: it|alic への挿入は斜字を維持する", async ({ openNote }) => {
    const page = await openNote({ content: "an *italic* word" });
    await placeCaret(page, 0, 6); // "an *it|alic* word"
    await page.keyboard.type("X", { delay: 10 });
    expect(await getContent(page)).toBe("an *itXalic* word");
  });

  test("文中の斜字（_italic_）: it|alic への挿入は斜字を維持する", async ({ openNote }) => {
    const page = await openNote({ content: "an _italic_ word" });
    await placeCaret(page, 0, 6);
    await page.keyboard.type("X", { delay: 10 });
    expect(await getContent(page)).toBe("an _itXalic_ word");
  });

  test("インラインコード: co|de への挿入はコード装飾を維持する", async ({ openNote }) => {
    const page = await openNote({ content: "see `code` here" });
    await placeCaret(page, 0, 7); // "see `co|de` here"
    await page.keyboard.type("X", { delay: 10 });
    expect(await getContent(page)).toBe("see `coXde` here");
    const code = await page.evaluate(() => document.querySelector("#markdown-view code")?.textContent);
    expect(code).toBe("coXde");
  });

  test("クリックでインラインコード内部にキャレットを置いても装飾を維持する", async ({ openNote }) => {
    const page = await openNote({ content: "see `code` here" });
    const code = page.locator("#markdown-view code");
    const box = await code.boundingBox();
    await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height / 2);
    await page.keyboard.type("X", { delay: 10 });
    expect(await getContent(page)).toBe("see `coXde` here");
  });
});
