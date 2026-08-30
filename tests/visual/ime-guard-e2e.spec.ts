import { test, expect, placeCaret, getContent } from "./fixtures";

// IME は compositionstart でキャレット/選択位置を退避し、compositionend で e.data を
// その位置へ splice して再描画する（WebKit がネイティブに書き込んだ DOM は巻き戻し扱いで
// 捨てる）。確定 Enter の二重処理ガードは未実装。

async function dispatchComposition(
  page: import("@playwright/test").Page,
  data: string,
) {
  await page.evaluate((d) => {
    const view = document.getElementById("markdown-view")!;
    view.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    view.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: d }));
  }, data);
}

test.describe("IME入力（暫定実装）", () => {
  test("compositionend で確定文字列がキャレット位置へ挿入される", async ({ openNote }) => {
    const page = await openNote({ content: "" });
    await placeCaret(page, 0, 0);

    await dispatchComposition(page, "あいう");

    expect(await getContent(page)).toBe("あいう");
  });

  test("行の途中に確定文字列が挿入される", async ({ openNote }) => {
    const page = await openNote({ content: "abc" });
    await placeCaret(page, 0, 1);

    await dispatchComposition(page, "X");

    expect(await getContent(page)).toBe("aXbc");
  });

  test("data が空（変換取消）→ 内容は変わらない", async ({ openNote }) => {
    const page = await openNote({ content: "abc" });
    await placeCaret(page, 0, 1);

    await dispatchComposition(page, "");

    expect(await getContent(page)).toBe("abc");
  });

  test("composing 中は beforeinput の insertText に介入しない（preventDefault しない）", async ({ openNote }) => {
    const page = await openNote({ content: "" });
    await placeCaret(page, 0, 0);

    const notCanceled = await page.evaluate(() => {
      const view = document.getElementById("markdown-view")!;
      view.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      const e = new InputEvent("beforeinput", {
        inputType: "insertText", data: "a", cancelable: true, bubbles: true,
      });
      return view.dispatchEvent(e);
    });

    expect(notCanceled).toBe(true);
    // beforeinput に介入していない（splice もしていない）ので rawContent は変わらない
    expect(await getContent(page)).toBe("");
  });
});
