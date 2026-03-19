import { test, expect } from "./fixtures";

// ── 1. 編集モード切替 ────────────────────────────────────

test.describe("編集モード切替", () => {
  test("空の付箋をクリック → 編集モードになる", async ({ openNote }) => {
    const page = await openNote({ content: "" });
    // 初期状態: プレビューモード
    await expect(page.locator(".markdown-view")).toBeVisible();
    await expect(page.locator(".editor")).toBeHidden();

    // プレビューをクリック → 編集モードに切替
    await page.click(".markdown-view");
    await expect(page.locator(".editor")).toBeVisible();
    await expect(page.locator(".markdown-view")).toBeHidden();
  });

  test("テキスト付き付箋（md記法なし）をクリック → 編集モードになる", async ({ openNote }) => {
    const page = await openNote({ content: "ただのテキスト" });
    await expect(page.locator(".markdown-view")).toBeVisible();

    await page.click(".markdown-view");
    await expect(page.locator(".editor")).toBeVisible();
    await expect(page.locator(".markdown-view")).toBeHidden();
  });

  test("md記法付き付箋をダブルクリック → 編集モードになる", async ({ openNote }) => {
    const page = await openNote({ content: "# Title" });
    await expect(page.locator(".markdown-view")).toBeVisible();

    // single clickでは編集モードにならない（edit_on_single_clickがfalse）
    await page.click(".markdown-view");
    await expect(page.locator(".markdown-view")).toBeVisible();

    // ダブルクリックで編集モードに
    await page.dblclick(".markdown-view");
    await expect(page.locator(".editor")).toBeVisible();
    await expect(page.locator(".markdown-view")).toBeHidden();
  });

  test("編集モードでエディタ外をクリック → プレビューモードに戻る", async ({ openNote }) => {
    const page = await openNote({ content: "テスト" });

    // 編集モードにする
    await page.click(".markdown-view");
    await expect(page.locator(".editor")).toBeVisible();

    // エディタ外（titlebar）をクリックしてblur
    // dispatchでblurイベントを発火（relatedTargetがnullになるようにする）
    await page.evaluate(() => {
      const editor = document.getElementById("editor")!;
      editor.dispatchEvent(new FocusEvent("blur", { relatedTarget: null }));
    });
    await expect(page.locator(".markdown-view")).toBeVisible();
    await expect(page.locator(".editor")).toBeHidden();
  });
});

// ── 2. チェックボックストグル ──────────────────────────────

test.describe("チェックボックストグル", () => {
  test("未チェックのチェックボックスをクリック → チェックが入る", async ({ openNote }) => {
    const page = await openNote({ content: "- [ ] task" });
    await expect(page.locator(".markdown-view")).toBeVisible();

    const checkbox = page.locator('input[type="checkbox"]');
    await expect(checkbox).not.toBeChecked();

    await checkbox.click();
    await expect(checkbox).toBeChecked();
  });

  test("チェック済みのチェックボックスをクリック → チェックが外れる", async ({ openNote }) => {
    const page = await openNote({ content: "- [x] done" });
    await expect(page.locator(".markdown-view")).toBeVisible();

    const checkbox = page.locator('input[type="checkbox"]');
    await expect(checkbox).toBeChecked();

    await checkbox.click();
    await expect(checkbox).not.toBeChecked();
  });
});

// ── 3. カラーピッカー ────────────────────────────────────

test.describe("カラーピッカー", () => {
  test("#btn-color をクリック → カラーピッカーが開く", async ({ openNote }) => {
    const page = await openNote();
    await expect(page.locator(".color-picker.open")).toHaveCount(0);

    await page.click("#btn-color");
    await expect(page.locator(".color-picker.open")).toBeVisible();
  });

  test("カラードットをクリック → .active が付く", async ({ openNote }) => {
    const page = await openNote({ color: "yellow" });
    await page.click("#btn-color");
    await expect(page.locator(".color-picker.open")).toBeVisible();

    // blueのドットをクリック
    await page.click('.color-dot[data-color="blue"]');
    await expect(page.locator('.color-dot[data-color="blue"]')).toHaveClass(/active/);
    // yellowのactiveが外れる
    await expect(page.locator('.color-dot[data-color="yellow"]')).not.toHaveClass(/active/);
  });

  test("ピッカー外をクリック → カラーピッカーが閉じる", async ({ openNote }) => {
    const page = await openNote();
    await page.click("#btn-color");
    await expect(page.locator(".color-picker.open")).toBeVisible();

    // ピッカー外（titlebar）をクリック
    await page.click(".titlebar", { position: { x: 5, y: 5 } });
    await expect(page.locator(".color-picker.open")).toHaveCount(0);
  });
});

// ── 4. コンテキストメニュー ──────────────────────────────

test.describe("コンテキストメニュー", () => {
  test("右クリック → コンテキストメニューが開く", async ({ openNote }) => {
    const page = await openNote({ content: "テスト" });
    // 編集モードにする
    await page.click(".markdown-view");
    await expect(page.locator(".editor")).toBeVisible();

    await page.click(".editor", { button: "right" });
    await expect(page.locator(".context-menu.open")).toBeVisible();
  });

  test("メニュー外をクリック → コンテキストメニューが閉じる", async ({ openNote }) => {
    const page = await openNote({ content: "テスト" });
    await page.click(".markdown-view");
    await page.click(".editor", { button: "right" });
    await expect(page.locator(".context-menu.open")).toBeVisible();

    // メニュー外をクリック（コンテキストメニューが覆っている場合があるのでforceで貫通）
    await page.click(".titlebar", { position: { x: 5, y: 5 }, force: true });
    await expect(page.locator(".context-menu.open")).toHaveCount(0);
  });

  test("「全選択」をクリック → エディタの全テキストが選択される", async ({ openNote }) => {
    const page = await openNote({ content: "hello world" });
    // 編集モードにする
    await page.click(".markdown-view");
    await expect(page.locator(".editor")).toBeVisible();

    // 右クリックでコンテキストメニューを開く
    await page.click(".editor", { button: "right" });
    await expect(page.locator(".context-menu.open")).toBeVisible();

    // 「全選択」をクリック
    await page.click('[data-action="selectAll"]');

    // 選択テキストを取得して検証
    const selectedText = await page.evaluate(() => window.getSelection()?.toString());
    expect(selectedText).toContain("hello world");
  });
});

// ── 5. ペースト（URLリンク変換） ─────────────────────────

test.describe("ペースト（URLリンク変換）", () => {
  test("選択テキスト + URLペースト → markdownリンクに変換", async ({ openNote }) => {
    const page = await openNote({ content: "" });

    // 編集モードにする
    await page.click(".markdown-view");
    await expect(page.locator(".editor")).toBeVisible();

    // "hello" と入力
    await page.locator(".editor").pressSequentially("hello");

    // "hello" を全選択
    await page.keyboard.press("Meta+a");

    // クリップボードにURLを設定してペーストイベントをdispatch
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

    // エディタ内容がmarkdownリンク形式になっていることを確認
    const content = await page.locator(".editor").innerText();
    expect(content).toBe("[hello](https://example.com)");
  });
});
