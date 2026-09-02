import { test, expect, placeCaret, getContent } from "./fixtures";

// 既定の white-space: normal は行末・連続スペースを畳んで幅 0 にするため、行末に半角スペースを
// 打ってもキャレットが視覚的に進まず、スペースそのものも見えない（実機 WKWebView での報告）。
// rawContent が唯一の真実である以上、raw にある空白は表示にもそのまま反映される必要がある。
// .markdown-view に white-space: pre-wrap を適用し、行ブロックの表示幅で検証する。

/** [data-line="0"] の可視テキストが実際に占める幅（px）。ブロック自身の getBoundingClientRect
 * はコンテナ幅いっぱいに伸びる（display: block）ため使えない。テキスト内容だけを Range で
 * 囲み、その外接矩形の幅で「末尾・連続スペースが実際の描画幅に寄与しているか」を見る。 */
function lineWidth(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-line="0"]')!;
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getBoundingClientRect().width;
  });
}

test.describe("行内の空白の表示反映", () => {
  test("行末に半角スペースを入力すると表示幅が広がり、raw content にも残る", async ({ openNote }) => {
    const page = await openNote({ content: "hello" });
    await placeCaret(page, 0, 5); // "hello" の行末

    const widthBefore = await lineWidth(page);
    await page.keyboard.type(" ", { delay: 10 });
    const widthAfter = await lineWidth(page);

    expect(widthAfter).toBeGreaterThan(widthBefore);
    expect(await getContent(page)).toBe("hello ");
  });

  test("連続する半角スペースが表示幅に反映される", async ({ openNote }) => {
    const single = await openNote({ content: "a b" });
    const double = await openNote({ content: "a  b" });

    const singleWidth = await lineWidth(single);
    const doubleWidth = await lineWidth(double);

    expect(doubleWidth).toBeGreaterThan(singleWidth);
  });
});
