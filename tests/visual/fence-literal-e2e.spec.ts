import { test, expect, placeCaret, getContent, commitHistory } from "./fixtures";

// 閉じられていない開きフェンス（```）の扱い（issue #84 段階①の仕様変更）:
//   - 対応する閉じフェンスが無い開きフェンスは、下の内容に関わらず常にリテラルのテキスト行
//     として描画する（コードブロック化しない）
//   - 閉じフェンスが編集の結果そのまま最終行になったら、下に入力する場所を確保するため
//     空行を1行自動追加する（applyLines の共通後処理。同一 splice に含まれ undo は1手）
// 詳細な描画判定は src/markdown.js の scanFenceRanges、追加ロジックは src/note.js の
// ensureTrailingLineAfterClosedFence を参照。

test.describe("閉じられていないフェンスの描画", () => {
  test("下に非空行がある未クローズフェンスはリテラルのテキスト行になる（コードブロック化しない）", async ({ openNote }) => {
    const page = await openNote({ content: "```\nhello" });
    const isCodeBlock = await page.evaluate(() => document.querySelector("#markdown-view pre.md-codeblock") != null);
    expect(isCodeBlock).toBe(false);
    const lineTexts = await page.evaluate(() => Array.from(document.querySelectorAll("#markdown-view [data-line]")).map((el) => el.textContent));
    expect(lineTexts).toEqual(["```", "hello"]);
  });

  test("下が空行のみの未クローズフェンスもリテラルのテキスト行になる", async ({ openNote }) => {
    const page = await openNote({ content: "```\n\n" });
    const isCodeBlock = await page.evaluate(() => document.querySelector("#markdown-view pre.md-codeblock") != null);
    expect(isCodeBlock).toBe(false);
  });

  test("下に何も無い（``` だけ）未クローズフェンスもリテラルのテキスト行になる", async ({ openNote }) => {
    const page = await openNote({ content: "```" });
    const isCodeBlock = await page.evaluate(() => document.querySelector("#markdown-view pre.md-codeblock") != null);
    expect(isCodeBlock).toBe(false);
  });

  test("リテラル行に打ち続けても、閉じフェンスが現れるまで通常のテキスト行のまま", async ({ openNote }) => {
    const page = await openNote({ content: "```\nhello" });
    await placeCaret(page, 1, "hello".length);
    await page.keyboard.type(" world", { delay: 10 });
    expect(await getContent(page)).toBe("```\nhello world");
    const isCodeBlock = await page.evaluate(() => document.querySelector("#markdown-view pre.md-codeblock") != null);
    expect(isCodeBlock).toBe(false);
  });
});

test.describe("閉じフェンスが最終行になったときの空行自動追加", () => {
  test("既存の閉じフェンス付きコードブロックの中身を編集 → 末尾に空行が1行足される", async ({ openNote }) => {
    const page = await openNote({ content: "```\ncode\n```" });
    await placeCaret(page, 1, "code".length);
    await page.keyboard.type("!", { delay: 10 });
    expect(await getContent(page)).toBe("```\ncode!\n```\n");
  });

  test("末尾行を削除して閉じフェンスが最終行になる → 空行が1行足される", async ({ openNote }) => {
    const page = await openNote({ content: "```\ncode\n```\nafter" });
    await placeCaret(page, 3, 0);
    await page.keyboard.press("Shift+End");
    await page.keyboard.press("Backspace");
    expect(await getContent(page)).toBe("```\ncode\n```\n");
  });

  test("undo は1手で追加前の状態に戻る", async ({ openNote }) => {
    const page = await openNote({ content: "```\ncode\n```\nafter" });
    await placeCaret(page, 3, 0);
    await page.keyboard.press("Shift+End");
    await page.keyboard.press("Backspace");
    await commitHistory(page); // 保存を確定させ history へ積ませる
    expect(await getContent(page)).toBe("```\ncode\n```\n");

    await page.evaluate(() => (window as unknown as { performUndo(): void }).performUndo());
    expect(await getContent(page)).toBe("```\ncode\n```\nafter");
  });

  test("すでに末尾に空行がある場合は追加しない（べき等）", async ({ openNote }) => {
    const page = await openNote({ content: "```\ncode\n```\n" });
    await placeCaret(page, 1, "code".length);
    await page.keyboard.type("!", { delay: 10 });
    expect(await getContent(page)).toBe("```\ncode!\n```\n");
  });

  test("リテラル行（コードブロック化していない未クローズフェンス）には空行を追加しない", async ({ openNote }) => {
    const page = await openNote({ content: "```\nhello" });
    await placeCaret(page, 1, "hello".length);
    await page.keyboard.type("!", { delay: 10 });
    expect(await getContent(page)).toBe("```\nhello!");
  });

  test("追加された空行に実際に入力できる（コードブロックの中に入らない）", async ({ openNote }) => {
    const page = await openNote({ content: "```\ncode\n```\nafter" });
    await placeCaret(page, 3, 0);
    await page.keyboard.press("Shift+End");
    await page.keyboard.press("Backspace"); // ここで末尾に空行が足される
    await placeCaret(page, 3, 0); // 足された空行
    await page.keyboard.type("hello", { delay: 10 });
    expect(await getContent(page)).toBe("```\ncode\n```\nhello");
  });

  // 足された空行の直前行は閉じフェンス（```）で、前行と結合すると記法が壊れるため
  // 行頭 Backspace の段階解除は no-op になる（note.js の行頭 Backspace 参照）。
  // つまり足された空行だけを Backspace で消すことはできない
  test("追加された空行の行頭 Backspace は前行が閉じフェンスのため no-op", async ({ openNote }) => {
    const page = await openNote({ content: "```\ncode\n```\nafter" });
    await placeCaret(page, 3, 0);
    await page.keyboard.press("Shift+End");
    await page.keyboard.press("Backspace");
    await placeCaret(page, 3, 0);
    await page.keyboard.press("Backspace");
    expect(await getContent(page)).toBe("```\ncode\n```\n");
  });
});

// リテラルの ``` 行での Enter による空コードブロック生成:
// 対応する閉じフェンスの無いリテラル行はそのままでは入力できるコードブロックにならないため、
// この行での Enter（キャレットの列は問わない）を生成のトリガーにする。トリガーは素の ```
// 単独行のみで、```js のような言語指定つきは対象外（シンタックスハイライトが無く言語指定に
// 機能が無いため、``` に続けて打った文字列を不可視の開きフェンス行へ取り込まない）。
test.describe("リテラルの ``` 行での Enter によるコードブロック生成", () => {
  test("``` 行末で Enter すると空の内容行 + 閉じフェンスが生成され、キャレットは内容行に置かれる", async ({ openNote }) => {
    const page = await openNote({ content: "```" });
    await placeCaret(page, 0);
    await page.keyboard.press("Enter");
    await page.keyboard.type("code", { delay: 10 });
    expect(await getContent(page)).toBe("```\ncode\n```\n");
  });

  test("```aaa のような文字列つきの行では発動せず、通常の行分割になる（aaa が消えない）", async ({ openNote }) => {
    const page = await openNote({ content: "```aaa" });
    await placeCaret(page, 0);
    await page.keyboard.press("Enter");
    expect(await getContent(page)).toBe("```aaa\n");
    const isCodeBlock = await page.evaluate(() => document.querySelector("#markdown-view pre.md-codeblock") != null);
    expect(isCodeBlock).toBe(false);
  });

  test("閉じまで揃った言語指定つきフェンス（```js 〜 ```）もリテラルのテキスト行として描画される", async ({ openNote }) => {
    const page = await openNote({ content: "```js\nlet x = 1;\n```" });
    const isCodeBlock = await page.evaluate(() => document.querySelector("#markdown-view pre.md-codeblock") != null);
    expect(isCodeBlock).toBe(false);
    const lineTexts = await page.evaluate(() => Array.from(document.querySelectorAll("#markdown-view [data-line]")).map((el) => el.textContent));
    expect(lineTexts).toEqual(["```js", "let x = 1;", "```"]);
  });

  test("言語指定つきフェンスの下に、さらに素のフェンスペアがあればそこからコードブロックになる（連鎖）", async ({ openNote }) => {
    const page = await openNote({ content: "```aaa\nbbb\n```\nccc\n```" });
    const isCodeBlock = await page.evaluate(() => document.querySelector("#markdown-view pre.md-codeblock") != null);
    expect(isCodeBlock).toBe(true);
    const lineTexts = await page.evaluate(() => Array.from(document.querySelectorAll("#markdown-view [data-line]")).map((el) => el.textContent));
    expect(lineTexts).toEqual(["```aaa", "bbb", "ccc"]);
  });

  test("undo は1手でリテラルの ``` 行に戻る", async ({ openNote }) => {
    const page = await openNote({ content: "```" });
    await placeCaret(page, 0);
    await page.keyboard.press("Enter");
    await commitHistory(page); // 保存を確定させ history へ積ませる
    expect(await getContent(page)).toBe("```\n\n```\n");

    await page.evaluate(() => (window as unknown as { performUndo(): void }).performUndo());
    expect(await getContent(page)).toBe("```");
  });

  test("すでに閉じたフェンスの内側での Enter は誤発動せず素の改行のまま", async ({ openNote }) => {
    const page = await openNote({ content: "```\ncode\n```" });
    await placeCaret(page, 1, "code".length);
    await page.keyboard.press("Enter");
    expect(await getContent(page)).toBe("```\ncode\n\n```\n");
  });

  test("``` 行の行頭（行末でない）での Enter でも生成される（矢印キーで入ると行頭に落ちるため）", async ({ openNote }) => {
    const page = await openNote({ content: "```" });
    await placeCaret(page, 0, 0);
    await page.keyboard.press("Enter");
    await page.keyboard.type("code", { delay: 10 });
    expect(await getContent(page)).toBe("```\ncode\n```\n");
  });

  test("``` 行の途中での Enter でも生成される（キャレットの列は問わない）", async ({ openNote }) => {
    const page = await openNote({ content: "```" });
    await placeCaret(page, 0, 1); // 1 文字目と 2 文字目の間
    await page.keyboard.press("Enter");
    expect(await getContent(page)).toBe("```\n\n```\n");
    const isCodeBlock = await page.evaluate(() => document.querySelector("#markdown-view pre.md-codeblock") != null);
    expect(isCodeBlock).toBe(true);
  });
});
