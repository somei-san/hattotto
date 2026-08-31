import { test, expect, placeCaret, getContent, waitForReveal } from "./fixtures";

// 装飾（**bold** 等）の可視文字内部への挿入は charMap（src/markdown.js の inlineSegments）で
// raw 位置へ厳密対応し、装飾が外れないことを確認する回帰テスト。境界規約により、可視末尾
// ちょうど（閉じマーカーの直前）への挿入は仕様どおり装飾の外側になる（このファイルでは対象外。
// 装飾の「内部」への挿入だけを検証する）。
//
// キャレットが装飾の中・境界にあるあいだはインライン生表示（reveal）が有効になり、
// markdown-view はその要素だけ生マーカー付き（.md-reveal）で表示する（`<strong>` 等の
// 装飾タグには変換されない）。装飾が維持されていることは、キャレットを装飾の外へ出した
// （mdView の blur）後の描画で確認する。

async function blurEditor(page: import("@playwright/test").Page) {
  await page.evaluate(() => (document.getElementById("markdown-view") as HTMLElement).blur());
}

test.describe("装飾の可視文字内部への挿入で装飾が維持される", () => {
  test("行全体が太字: bo|ld への挿入は太字を維持する", async ({ openNote }) => {
    const page = await openNote({ content: "**bold**" });
    await placeCaret(page, 0, 4); // "**bo|ld**"
    await waitForReveal(page, { line: 0, start: 0, end: 8 });
    await page.keyboard.type("X", { delay: 10 });
    expect(await getContent(page)).toBe("**boXld**");
    // 挿入直後もキャレットは装飾内部のまま → 生マーカーが見えている
    await waitForReveal(page, { line: 0, start: 0, end: 9 });
    const revealText = await page.locator("#markdown-view .md-reveal").textContent();
    expect(revealText).toBe("**boXld**");
    // キャレットが装飾から離れると通常どおり太字として描画される
    await blurEditor(page);
    const strong = await page.evaluate(() => document.querySelector("#markdown-view strong")?.textContent);
    expect(strong).toBe("boXld");
  });

  test("文中の太字: pre **bo|ld** post への挿入は太字を維持する", async ({ openNote }) => {
    const page = await openNote({ content: "pre **bold** post" });
    await placeCaret(page, 0, 8); // "pre **bo|ld** post"
    await waitForReveal(page, { line: 0, start: 4, end: 12 });
    await page.keyboard.type("X", { delay: 10 });
    expect(await getContent(page)).toBe("pre **boXld** post");
    await blurEditor(page);
    const strong = await page.evaluate(() => document.querySelector("#markdown-view strong")?.textContent);
    expect(strong).toBe("boXld");
  });

  test("リスト項目内の太字: - **bo|ld** item への挿入は太字を維持する", async ({ openNote }) => {
    const page = await openNote({ content: "- **bold** item" });
    await placeCaret(page, 0, 6); // "- **bo|ld** item"
    // reveal の start/end は行頭マーカー（"- "）を除いた内容側のローカルなオフセット
    await waitForReveal(page, { line: 0, start: 0, end: 8 });
    await page.keyboard.type("X", { delay: 10 });
    expect(await getContent(page)).toBe("- **boXld** item");
    await blurEditor(page);
    const strong = await page.evaluate(() => document.querySelector("#markdown-view strong")?.textContent);
    expect(strong).toBe("boXld");
  });

  test("クリックで装飾内部にキャレットを置いても太字を維持する", async ({ openNote }) => {
    const page = await openNote({ content: "pre **bold** post" });
    const strong = page.locator("#markdown-view strong");
    const box = await strong.boundingBox();
    await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height / 2);
    await waitForReveal(page, { line: 0, start: 4, end: 12 });
    await page.keyboard.type("X", { delay: 10 });
    expect(await getContent(page)).toBe("pre **boXld** post");
    await blurEditor(page);
    const strongText = await page.evaluate(() => document.querySelector("#markdown-view strong")?.textContent);
    expect(strongText).toBe("boXld");
  });

  test("IME 確定（compositionend）で装飾内部に文字を挿入しても太字を維持する", async ({ openNote }) => {
    const page = await openNote({ content: "pre **bold** post" });
    await placeCaret(page, 0, 8); // "pre **bo|ld** post"
    await waitForReveal(page, { line: 0, start: 4, end: 12 });
    await page.evaluate(() => {
      const mdView = document.getElementById("markdown-view")!;
      mdView.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
      mdView.dispatchEvent(new CompositionEvent("compositionend", { data: "あ" }));
    });
    expect(await getContent(page)).toBe("pre **boあld** post");
    await blurEditor(page);
    const strong = await page.evaluate(() => document.querySelector("#markdown-view strong")?.textContent);
    expect(strong).toBe("boあld");
  });

  test("文中の斜字（*italic*）: it|alic への挿入は斜字を維持する", async ({ openNote }) => {
    const page = await openNote({ content: "an *italic* word" });
    await placeCaret(page, 0, 6); // "an *it|alic* word"
    await waitForReveal(page, { line: 0, start: 3, end: 11 });
    await page.keyboard.type("X", { delay: 10 });
    expect(await getContent(page)).toBe("an *itXalic* word");
    await blurEditor(page);
    const em = await page.evaluate(() => document.querySelector("#markdown-view em")?.textContent);
    expect(em).toBe("itXalic");
  });

  test("文中の斜字（_italic_）: it|alic への挿入は斜字を維持しない（_ は装飾記法として扱わない）", async ({ openNote }) => {
    const page = await openNote({ content: "an _italic_ word" });
    await placeCaret(page, 0, 6);
    // _italic_ は inlineSegments 上ただのプレーンテキストなので reveal 対象にならない
    await waitForReveal(page, null);
    await page.keyboard.type("X", { delay: 10 });
    expect(await getContent(page)).toBe("an _itXalic_ word");
  });

  test("インラインコード: co|de への挿入はコード装飾を維持する", async ({ openNote }) => {
    const page = await openNote({ content: "see `code` here" });
    await placeCaret(page, 0, 7); // "see `co|de` here"
    await waitForReveal(page, { line: 0, start: 4, end: 10 });
    await page.keyboard.type("X", { delay: 10 });
    expect(await getContent(page)).toBe("see `coXde` here");
    await blurEditor(page);
    const code = await page.evaluate(() => document.querySelector("#markdown-view code")?.textContent);
    expect(code).toBe("coXde");
  });

  test("クリックでインラインコード内部にキャレットを置いても装飾を維持する", async ({ openNote }) => {
    const page = await openNote({ content: "see `code` here" });
    const code = page.locator("#markdown-view code");
    const box = await code.boundingBox();
    await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height / 2);
    await waitForReveal(page, { line: 0, start: 4, end: 10 });
    await page.keyboard.type("X", { delay: 10 });
    expect(await getContent(page)).toBe("see `coXde` here");
    await blurEditor(page);
    const codeText = await page.evaluate(() => document.querySelector("#markdown-view code")?.textContent);
    expect(codeText).toBe("coXde");
  });
});
