import { test, expect, enterEdit, getContent, placeCaret } from "./fixtures";

/**
 * 生エディタへ keydown を直接投げる。
 * chromium では実際の変換操作を再現できないため、IME 経由の keydown が持つ
 * 属性（keyCode 229 / isComposing）を組み立ててガードの判定だけを検証する。
 */
async function sendKeydown(
  page: import("@playwright/test").Page,
  init: { key: string; keyCode?: number; isComposing?: boolean },
) {
  await page.evaluate((opts) => {
    document.getElementById("editor")!.dispatchEvent(
      new KeyboardEvent("keydown", { ...opts, bubbles: true, cancelable: true }),
    );
  }, init);
}

test.describe("IME入力ガード", () => {
  test("isComposing=true → チェックボックス自動補完が発動しない", async ({ openNote }) => {
    const page = await openNote({ content: "" });

    await enterEdit(page);

    // "- [" まで入力
    await page.locator("#editor").pressSequentially("- [");

    // isComposing=true で ']' を dispatch → 自動補完されないはず
    await page.evaluate(() => {
      const editor = document.getElementById("editor")!;
      const inputEvent = new InputEvent("input", {
        data: "]",
        inputType: "insertText",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(inputEvent);
    });

    // エディタ内容が自動補完されていないことを確認
    // （"- [" のままで "- [ ] " に変換されていない）
    const content = await getContent(page);
    expect(content).not.toContain("- [ ] ");
  });

  test("isComposing=false + data=']' → チェックボックス自動補完が発動する", async ({ openNote }) => {
    const page = await openNote({ content: "" });

    await enterEdit(page);

    // "- []" と入力（最後の ']' で自動補完がトリガーされる）
    await page.locator("#editor").pressSequentially("- []");

    // 自動補完が発動して "- [ ] " になることを確認
    await expect.poll(
      () => getContent(page),
      { timeout: 3000 },
    ).toBe("- [ ] ");
  });

  // ── 変換確定の Enter で行が割れない ──────────────────
  // WebKit は確定 Enter の keydown より先に compositionend を出すため、
  // その keydown では composing も isComposing も false になっている。

  test("compositionend の後に keyCode 229 の Enter → 行が分割されない", async ({ openNote }) => {
    const page = await openNote({ content: "あいう" });
    await placeCaret(page, 0, 2);

    await page.evaluate(() => {
      const ed = document.getElementById("editor")!;
      ed.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      ed.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "あいう" }));
    });
    await sendKeydown(page, { key: "Enter", keyCode: 229 });

    expect(await getContent(page)).toBe("あいう");
  });

  test("isComposing=true の Enter → 行が分割されない", async ({ openNote }) => {
    const page = await openNote({ content: "あいう" });
    await placeCaret(page, 0, 2);

    await sendKeydown(page, { key: "Enter", isComposing: true });

    expect(await getContent(page)).toBe("あいう");
  });

  test("変換確定の直後でも、通常の Enter は行を分割する", async ({ openNote }) => {
    const page = await openNote({ content: "あいう" });
    await placeCaret(page, 0, 2);

    await page.evaluate(() => {
      const ed = document.getElementById("editor")!;
      ed.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      ed.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "あいう" }));
    });
    await page.keyboard.press("Enter");

    expect(await getContent(page)).toBe("あい\nう");
  });

  test("keyCode 229 の Backspace → 前の行と結合しない", async ({ openNote }) => {
    const page = await openNote({ content: "一行目\n二行目" });
    await placeCaret(page, 1, 0);

    await sendKeydown(page, { key: "Backspace", keyCode: 229 });

    expect(await getContent(page)).toBe("一行目\n二行目");
  });

  test("変換中の ArrowUp → 行移動に奪われない", async ({ openNote }) => {
    const page = await openNote({ content: "一行目\n二行目" });
    await placeCaret(page, 1, 0);

    await sendKeydown(page, { key: "ArrowUp", isComposing: true });

    expect(await page.locator("#editor").textContent()).toBe("二行目");
  });
});
