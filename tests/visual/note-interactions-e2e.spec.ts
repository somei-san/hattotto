import { test, expect, injectNoteMock } from "./fixtures";

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

// ── 4-8. コンテキストメニュー（ネイティブメニュー移行済み — Playwrightでテスト不可）──

// コンテキストメニューはTauri Menu::popup()でネイティブ表示されるため、
// Playwrightからの操作・検証ができない。実機テストで確認する。

test.describe.skip("コンテキストメニュー（ネイティブ）", () => {
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

// ── 6. コンテキストメニュー：ズーム ─────────────────────────

test.describe.skip("コンテキストメニュー：ズーム", () => {
  test("ズームイン → #note の zoom が増加する", async ({ openNote }) => {
    const page = await openNote({ content: "テスト", zoom: 100 });
    await page.click(".markdown-view");
    await expect(page.locator(".editor")).toBeVisible();

    await page.click(".editor", { button: "right" });
    await expect(page.locator(".context-menu.open")).toBeVisible();
    await page.click('[data-action="zoomIn"]');

    const zoom = await page.evaluate(() => document.getElementById('note').style.zoom);
    expect(parseFloat(zoom)).toBeGreaterThan(1);
  });

  test("ズームアウト → #note の zoom が減少する", async ({ openNote }) => {
    const page = await openNote({ content: "テスト", zoom: 100 });
    await page.click(".markdown-view");
    await expect(page.locator(".editor")).toBeVisible();

    await page.click(".editor", { button: "right" });
    await expect(page.locator(".context-menu.open")).toBeVisible();
    await page.click('[data-action="zoomOut"]');

    const zoom = await page.evaluate(() => document.getElementById('note').style.zoom);
    expect(parseFloat(zoom)).toBeLessThan(1);
  });

  test("ズームリセット → #note の zoom が 1 に戻る", async ({ openNote }) => {
    const page = await openNote({ content: "テスト", zoom: 100 });

    // まずズームインして1より大きくする
    await page.click(".markdown-view");
    await expect(page.locator(".editor")).toBeVisible();
    await page.click(".editor", { button: "right" });
    await expect(page.locator(".context-menu.open")).toBeVisible();
    await page.click('[data-action="zoomIn"]');

    const zoomedIn = await page.evaluate(() => document.getElementById('note').style.zoom);
    expect(parseFloat(zoomedIn)).toBeGreaterThan(1);

    // ズームリセット
    await page.click(".editor", { button: "right" });
    await expect(page.locator(".context-menu.open")).toBeVisible();
    await page.click('[data-action="zoomReset"]');

    const zoom = await page.evaluate(() => document.getElementById('note').style.zoom);
    expect(parseFloat(zoom)).toBe(1);
  });
});

// ── 7. コンテキストメニュー：ピン留めトグル ──────────────────

test.describe.skip("コンテキストメニュー：ピン留めトグル", () => {
  test("ピン留め → #btn-pin に .active が付き、ラベルが切り替わる", async ({ openNote }) => {
    const page = await openNote({ content: "テスト" });
    await expect(page.locator("#btn-pin")).not.toHaveClass(/active/);

    // 編集モード → コンテキストメニュー → ピン留め
    await page.click(".markdown-view");
    await expect(page.locator(".editor")).toBeVisible();
    await page.click(".editor", { button: "right" });
    await expect(page.locator(".context-menu.open")).toBeVisible();

    // ラベルが「ピン留め」であること
    await expect(page.locator("#ctx-pin-label")).toHaveText("ピン留め");
    await page.click('[data-action="togglePin"]');

    await expect(page.locator("#btn-pin")).toHaveClass(/active/);

    // 再度コンテキストメニューを開くとラベルが「ピン留め解除」
    await page.click(".editor", { button: "right" });
    await expect(page.locator("#ctx-pin-label")).toHaveText("ピン留め解除");
  });

  test("ピン留め解除 → #btn-pin から .active が外れる", async ({ openNote }) => {
    const page = await openNote({ content: "テスト", pinned: true });
    await expect(page.locator("#btn-pin")).toHaveClass(/active/);

    await page.click(".markdown-view");
    await expect(page.locator(".editor")).toBeVisible();
    await page.click(".editor", { button: "right" });
    await expect(page.locator(".context-menu.open")).toBeVisible();

    await expect(page.locator("#ctx-pin-label")).toHaveText("ピン留め解除");
    await page.click('[data-action="togglePin"]');

    await expect(page.locator("#btn-pin")).not.toHaveClass(/active/);
  });
});

// ── 8. コンテキストメニュー：カラー変更 ──────────────────────

test.describe.skip("コンテキストメニュー：カラー変更", () => {
  test("コンテキストメニューから色を変更 → --bg CSS変数が変わる", async ({ openNote }) => {
    const page = await openNote({ content: "テスト", color: "yellow" });
    await page.click(".markdown-view");
    await expect(page.locator(".editor")).toBeVisible();

    await page.click(".editor", { button: "right" });
    await expect(page.locator(".context-menu.open")).toBeVisible();

    // blueを選択
    await page.click('.cm-color-dot[data-color="blue"]');

    const bg = await page.evaluate(() => {
      return document.querySelector(".note")!.style.getPropertyValue("--bg");
    });
    expect(bg).toBe("var(--blue)");
  });
});

// ── 9. ピン留めボタン ────────────────────────────────────────

test.describe("ピン留めボタン", () => {
  test("#btn-pin をクリック → .active が付く", async ({ openNote }) => {
    const page = await openNote({ content: "テスト" });
    await expect(page.locator("#btn-pin")).not.toHaveClass(/active/);

    await page.click("#btn-pin");
    await expect(page.locator("#btn-pin")).toHaveClass(/active/);
  });

  test("再度クリック → .active が外れる", async ({ openNote }) => {
    const page = await openNote({ content: "テスト", pinned: true });
    await expect(page.locator("#btn-pin")).toHaveClass(/active/);

    await page.click("#btn-pin");
    await expect(page.locator("#btn-pin")).not.toHaveClass(/active/);
  });
});

// ── 10. ボタン表示/非表示設定 ────────────────────────────────

test.describe("ボタン表示/非表示設定", () => {
  test("show_pin_button: false → #btn-pin が非表示", async ({ openNote }) => {
    const page = await openNote({}, { show_pin_button: false });
    await expect(page.locator("#btn-pin")).toBeHidden();
  });

  test("show_new_button: false → #btn-new が非表示", async ({ openNote }) => {
    const page = await openNote({}, { show_new_button: false });
    await expect(page.locator("#btn-new")).toBeHidden();
  });

  test("show_color_button: false → #btn-color が非表示", async ({ openNote }) => {
    const page = await openNote({}, { show_color_button: false });
    await expect(page.locator("#btn-color")).toBeHidden();
  });
});

// ── 11. 自動保存（デバウンス） ───────────────────────────────

test.describe("自動保存", () => {
  test("テキスト入力 → 300ms後にinvokeが呼ばれる", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();

    // 共有モックを注入（invokeキャプチャ内蔵）してページ遷移
    await injectNoteMock(page, { content: "" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    // 編集モードにする
    await page.click(".markdown-view");
    await expect(page.locator(".editor")).toBeVisible();

    // キャプチャをリセット
    await page.evaluate(() => { (window as any).__captured_invokes.length = 0; });

    // 単一文字入力後すぐにチェック（タイミング信頼性のため1文字のみ）
    await page.locator(".editor").press("h");

    // 入力直後はデバウンス中なのでまだ呼ばれない
    const callsBefore = await page.evaluate(() =>
      (window as any).__captured_invokes.filter((c: any) => c.cmd === "update_note_content")
    );
    expect(callsBefore).toHaveLength(0);

    // 条件ベースで待機（デバウンス完了を検知）
    await expect.poll(() =>
      page.evaluate(() =>
        (window as any).__captured_invokes.filter((c: any) => c.cmd === "update_note_content").length
      ),
      { timeout: 5000 },
    ).toBe(1);

    const callsAfter = await page.evaluate(() =>
      (window as any).__captured_invokes.filter((c: any) => c.cmd === "update_note_content")
    );
    expect((callsAfter[0] as any).args.content).toContain("h");

    await ctx.close();
  });
});
