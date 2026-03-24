import { test, expect, injectNoteMock } from "./fixtures";

test.describe("ペースト処理", () => {
  test("空の選択状態でURLペースト → リンク変換されずプレーンURL挿入", async ({ openNote }) => {
    const page = await openNote({ content: "" });

    // 編集モードにする
    await page.click(".markdown-view");
    await expect(page.locator(".editor")).toBeVisible();

    // 選択なしでURLをペースト
    await page.evaluate(() => {
      const editor = document.getElementById("editor")!;
      const dt = new DataTransfer();
      dt.setData("text/plain", "https://example.com");
      const pasteEvent = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(pasteEvent);
    });

    const content = await page.locator(".editor").innerText();
    expect(content).toBe("https://example.com");
  });

  test("リッチテキスト（HTML含む）ペースト → Markdownに変換", async ({ openNote }) => {
    const page = await openNote({ content: "" });

    await page.click(".markdown-view");
    await expect(page.locator(".editor")).toBeVisible();

    await page.evaluate(() => {
      const editor = document.getElementById("editor")!;
      const dt = new DataTransfer();
      dt.setData("text/plain", "bold text");
      dt.setData("text/html", "<strong>bold text</strong>");
      const pasteEvent = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(pasteEvent);
    });

    const content = await page.locator(".editor").innerText();
    expect(content).toBe("**bold text**");
  });

  test("プレーンテキストペースト → そのまま挿入", async ({ openNote }) => {
    const page = await openNote({ content: "" });

    await page.click(".markdown-view");
    await expect(page.locator(".editor")).toBeVisible();

    await page.evaluate(() => {
      const editor = document.getElementById("editor")!;
      const dt = new DataTransfer();
      dt.setData("text/plain", "plain text here");
      const pasteEvent = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(pasteEvent);
    });

    const content = await page.locator(".editor").innerText();
    expect(content).toBe("plain text here");
  });

  test("複数行選択 + URLペースト → 選択範囲全体がMarkdownリンクになる", async ({ openNote }) => {
    const page = await openNote({ content: "" });

    await page.click(".markdown-view");
    await expect(page.locator(".editor")).toBeVisible();

    // テキストを入力して全選択
    await page.locator(".editor").pressSequentially("multi line text");
    const mod = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${mod}+a`);

    await page.evaluate(() => {
      const editor = document.getElementById("editor")!;
      const dt = new DataTransfer();
      dt.setData("text/plain", "https://example.com/page");
      const pasteEvent = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(pasteEvent);
    });

    const content = await page.locator(".editor").innerText();
    expect(content).toBe("[multi line text](https://example.com/page)");
  });

  test("リッチテキスト（リンク付き）ペースト → Markdownリンクに変換", async ({ openNote }) => {
    const page = await openNote({ content: "" });

    await page.click(".markdown-view");
    await expect(page.locator(".editor")).toBeVisible();

    await page.evaluate(() => {
      const editor = document.getElementById("editor")!;
      const dt = new DataTransfer();
      dt.setData("text/plain", "click here");
      dt.setData("text/html", '<a href="https://example.com">click here</a>');
      const pasteEvent = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(pasteEvent);
    });

    const content = await page.locator(".editor").innerText();
    expect(content).toBe("[click here](https://example.com)");
  });
});
