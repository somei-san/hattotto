import { test, expect } from "./fixtures";

test.describe("IME入力ガード", () => {
  test("isComposing=true → チェックボックス自動補完が発動しない", async ({ openNote }) => {
    const page = await openNote({ content: "" });

    // 編集モードにする
    await page.click(".markdown-view");
    await expect(page.locator(".editor")).toBeVisible();

    // "- [" まで入力
    await page.locator(".editor").pressSequentially("- [");

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
    const content = await page.locator(".editor").innerText();
    expect(content).not.toContain("- [ ] ");
  });

  test("isComposing=false + data=']' → チェックボックス自動補完が発動する", async ({ openNote }) => {
    const page = await openNote({ content: "" });

    // 編集モードにする
    await page.click(".markdown-view");
    await expect(page.locator(".editor")).toBeVisible();

    // "- []" と入力（最後の ']' で自動補完がトリガーされる）
    await page.locator(".editor").pressSequentially("- []");

    // 自動補完が発動して "- [ ] " になることを確認
    await expect.poll(
      () => page.locator(".editor").innerText(),
      { timeout: 3000 },
    ).toBe("- [ ] ");
  });
});
