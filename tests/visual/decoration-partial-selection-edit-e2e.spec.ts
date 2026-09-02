import { test, expect, getContent, placeCaret, selectMarkdownRange, commitHistory } from "./fixtures";

// 部分的に選択された装飾（太字/斜字/取り消し線/インラインコード/リンク）の削除・置換。
// 選択が装飾セグメントを部分的にしか覆っていないとき、そのセグメントのマーカーは保存し
// 中身の文字だけを削除する。装飾全体を覆う選択は従来どおり
// マーカーごと削除される。可視文字が空になった装飾（削除の結果 `` **** `` 等になるもの）は
// 同じ splice でマーカーごと正規化する。resolveSelectionBounds（コピー・「Markdown をコピー」）
// の意味は変えていないため、削除範囲だけがこの仕様の対象になる。

/** document へ cut の ClipboardEvent を dispatch し、preventDefault の有無とセットされた
 * text/plain を返す。 */
function dispatchCutWithClipboardData(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const dt = new DataTransfer();
    const ev = new ClipboardEvent("cut", { bubbles: true, cancelable: true, clipboardData: dt });
    const notCanceled = document.dispatchEvent(ev);
    return { notCanceled, plain: dt.getData("text/plain") };
  });
}

function dispatchPaste(page: import("@playwright/test").Page, plain: string) {
  return page.evaluate((p) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", p);
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
  }, plain);
}

/** mdView を blur して reveal を確実に解除する。splice 直後の selectionchange（キャレット
 * 復元）はブラウザが非同期に発火するため、blur を先に投げると「まだ revealState が更新されて
 * いない」タイミングに当たって blur の条件分岐（if (!revealState) return）が素通りし、直後に
 * 遅れて届いた selectionchange が改めて reveal を有効化してしまうことがある（1 行に複数の
 * 装飾がある行で発生しやすい）。先に selectionchange の決着を待ってから blur する。 */
async function blurEditor(page: import("@playwright/test").Page) {
  await page.waitForTimeout(100);
  await page.evaluate(() => (document.getElementById("markdown-view") as HTMLElement).blur());
  await page.waitForTimeout(50);
}

/** キャレットが装飾セグメントの手前（srcStart、reveal 前から到達できる安定した境界）にある
 * 前提で、生表示（reveal）中の raw をマーカー分だけ矢印キーで進める。
 * 1 文字だけの内容（例: `**x**`）は「マーカーの直後・内容の直前」という raw 位置に
 * 直接キャレットを置けない（可視末尾＝装飾全体の境界としてしか置けない、境界規約）ため、
 * 一度 reveal を有効にしてから raw 1 文字ずつ進んで内容の直前まで辿り着く必要がある。 */
async function stepRight(page: import("@playwright/test").Page, times: number) {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(50);
  }
}

test.describe("部分選択された太字の削除はマーカーを保存する", () => {
  test("可視「b」だけ削除 → 太字は維持され中身だけ削れる", async ({ openNote }) => {
    const page = await openNote({ content: "abc **bold** def" });

    // 可視 "abc bold def" の "b"（4〜5文字目）だけを選択する
    await selectMarkdownRange(page, 0, 4, 0, 5);
    await page.keyboard.press("Backspace");

    expect(await getContent(page)).toBe("abc **old** def");
    // 削除直後はキャレットが装飾の可視末尾に残り reveal が有効なままなので、装飾タグでの
    // 描画（blur で reveal を解除した後の見た目）を見るには一度 blur する
    await blurEditor(page);
    expect(await page.locator("#markdown-view strong").textContent()).toBe("old");
  });

  test("可視「old de」を削除 → 残った「b」がマーカー付きで残る", async ({ openNote }) => {
    const page = await openNote({ content: "abc **bold** def" });

    await selectMarkdownRange(page, 0, 5, 0, 11); // 可視 "old de"
    await page.keyboard.press("Delete");

    expect(await getContent(page)).toBe("abc **b**f");
    await blurEditor(page);
    expect(await page.locator("#markdown-view strong").textContent()).toBe("b");
  });

  test("装飾全体を覆う選択は従来どおりマーカーごと削除される", async ({ openNote }) => {
    const page = await openNote({ content: "abc **bold** def" });

    await selectMarkdownRange(page, 0, 4, 0, 8); // 可視 "bold" 全体
    await page.keyboard.press("Backspace");

    expect(await getContent(page)).toBe("abc  def");
    expect(await page.locator("#markdown-view strong").count()).toBe(0);
  });

  test("装飾をまたぐ選択は両側それぞれの部分覆いセグメントのマーカーを保存する", async ({ openNote }) => {
    const page = await openNote({ content: "**bold** and *italic*" });

    // 可視 "bold and italic" のうち "ld and ita"（太字の途中〜斜字の途中）を選択
    await selectMarkdownRange(page, 0, 2, 0, 12);
    await page.keyboard.press("Backspace");

    expect(await getContent(page)).toBe("**bo***lic*");
    await blurEditor(page);
    expect(await page.locator("#markdown-view strong").textContent()).toBe("bo");
    expect(await page.locator("#markdown-view em").textContent()).toBe("lic");
  });

  test("部分選択の削除は undo 1 手で元に戻る", async ({ openNote }) => {
    const page = await openNote({ content: "abc **bold** def" });

    await selectMarkdownRange(page, 0, 4, 0, 5);
    await page.keyboard.press("Backspace");
    expect(await getContent(page)).toBe("abc **old** def");

    await commitHistory(page); // 保存を確定させ history へ積ませる
    await page.evaluate(() => (window as unknown as { performUndo(): Promise<void> }).performUndo());

    expect(await getContent(page)).toBe("abc **bold** def");
  });
});

test.describe("部分選択への置換（タイピング・ペースト）も同じ範囲解決を使う", () => {
  test("部分選択中のタイピングは削除範囲の位置＝装飾の中に入る", async ({ openNote }) => {
    const page = await openNote({ content: "abc **bold** def" });

    await selectMarkdownRange(page, 0, 4, 0, 5); // 可視 "b"
    await page.keyboard.press("X");

    expect(await getContent(page)).toBe("abc **Xold** def");
    await blurEditor(page);
    expect(await page.locator("#markdown-view strong").textContent()).toBe("Xold");
  });

  test("部分選択中のペーストも同じ位置（装飾の中）に入る", async ({ openNote }) => {
    const page = await openNote({ content: "abc **bold** def" });

    await selectMarkdownRange(page, 0, 4, 0, 5); // 可視 "b"
    await dispatchPaste(page, "XY");

    expect(await getContent(page)).toBe("abc **XYold** def");
    await blurEditor(page);
    expect(await page.locator("#markdown-view strong").textContent()).toBe("XYold");
  });

  test("保存区間が閉じマーカーだけ（insertOffset=0）でも挿入位置がずれない", async ({ openNote }) => {
    const page = await openNote({ content: "abc **bold** def" });

    await selectMarkdownRange(page, 0, 5, 0, 11); // 可視 "old de"
    await page.keyboard.press("X");

    expect(await getContent(page)).toBe("abc **bX**f");
    await blurEditor(page);
    expect(await page.locator("#markdown-view strong").textContent()).toBe("bX");
  });
});

test.describe("⌘X はコピーされる可視範囲と削除される可視範囲が一致する", () => {
  test("選択の端が装飾の内部に落ちても、クリップボードの可視テキストと削除後に失われた可視テキストが一致する", async ({ openNote }) => {
    const page = await openNote({ content: "abc **bold** def" });

    await selectMarkdownRange(page, 0, 5, 0, 11); // 可視 "old de"
    const { notCanceled, plain } = await dispatchCutWithClipboardData(page);

    expect(notCanceled).toBe(false); // preventDefault された
    expect(plain).toBe("old de");
    // 削除後に残る可視テキストは "abc b" + "f" = "abc bf"（"old de" だけが失われる）。
    // 削除直後はキャレットが装飾の可視末尾に残り reveal が有効なままなので、装飾タグでの
    // 描画（blur で reveal を解除した後の見た目）を見るには一度 blur する
    expect(await getContent(page)).toBe("abc **b**f");
    await blurEditor(page);
    expect(await page.locator("#markdown-view").textContent()).toBe("abc bf");
  });
});

test.describe("可視文字が空になった装飾はマーカーごと正規化される", () => {
  // 1 文字だけの内容（例: `**x**`）は、マーカーの直後・内容の直前という raw 位置に collapsed
  // キャレットを直接置けない（可視末尾は装飾全体の境界＝srcEnd を指す境界規約のため）。装飾の
  // 手前（srcStart、常に到達できる境界）へ置いて reveal を有効にし、そこから raw をマーカー分
  // だけ矢印キーで進めてから Delete で内容を削除する。

  test("太字: 内容 1 文字を Delete で削除 → マーカーごと消える", async ({ openNote }) => {
    const page = await openNote({ content: "abc **x** def" });
    await placeCaret(page, 0, 4); // "abc |**x** def"（装飾の手前）
    await stepRight(page, 2); // 開くマーカー "**" を越えて内容 "x" の直前へ
    await page.keyboard.press("Delete");

    expect(await getContent(page)).toBe("abc  def");
    await blurEditor(page);
    expect(await page.locator("#markdown-view strong").count()).toBe(0);
  });

  test("斜字: 内容 1 文字を Delete で削除 → マーカーごと消える", async ({ openNote }) => {
    const page = await openNote({ content: "abc *x* def" });
    await placeCaret(page, 0, 4); // "abc |*x* def"
    await stepRight(page, 1); // 開くマーカー "*" を越えて内容の直前へ
    await page.keyboard.press("Delete");

    expect(await getContent(page)).toBe("abc  def");
    await blurEditor(page);
    expect(await page.locator("#markdown-view em").count()).toBe(0);
  });

  test("取り消し線: 内容 1 文字を Delete で削除 → マーカーごと消える", async ({ openNote }) => {
    const page = await openNote({ content: "abc ~~x~~ def" });
    await placeCaret(page, 0, 4); // "abc |~~x~~ def"
    await stepRight(page, 2); // 開くマーカー "~~" を越えて内容の直前へ
    await page.keyboard.press("Delete");

    expect(await getContent(page)).toBe("abc  def");
    await blurEditor(page);
    expect(await page.locator("#markdown-view del").count()).toBe(0);
  });

  test("インラインコード: 内容 1 文字を Delete で削除 → マーカーごと消える", async ({ openNote }) => {
    const page = await openNote({ content: "abc `x` def" });
    await placeCaret(page, 0, 4); // "abc |`x` def"
    await stepRight(page, 1); // 開くマーカー "`" を越えて内容の直前へ
    await page.keyboard.press("Delete");

    expect(await getContent(page)).toBe("abc  def");
    await blurEditor(page);
    expect(await page.locator("#markdown-view code").count()).toBe(0);
  });

  test("リンクは対象外: ラベル 1 文字を削除してもマーカー（[]・(url)）は残る", async ({ openNote }) => {
    const page = await openNote({ content: "abc [x](https://example.com) def" });
    await placeCaret(page, 0, 4); // "abc |[x](https://example.com) def"
    await stepRight(page, 1); // "[" を越えてラベル "x" の直前へ
    await page.keyboard.press("Delete");

    expect(await getContent(page)).toBe("abc [](https://example.com) def");
    await blurEditor(page);
    const link = page.locator("#markdown-view a");
    await expect(link).toHaveCount(1);
    expect(await link.getAttribute("href")).toBe("https://example.com");
  });

  test("空マーカー正規化は undo 1 手で元に戻る", async ({ openNote }) => {
    const page = await openNote({ content: "abc **x** def" });
    await placeCaret(page, 0, 4);
    await stepRight(page, 2);
    await page.keyboard.press("Delete");
    expect(await getContent(page)).toBe("abc  def");

    await commitHistory(page);
    await page.evaluate(() => (window as unknown as { performUndo(): Promise<void> }).performUndo());

    expect(await getContent(page)).toBe("abc **x** def");
  });
});
