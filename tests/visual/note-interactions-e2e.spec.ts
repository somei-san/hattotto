import { test, expect, injectNoteMock, enterEdit, getContent } from "./fixtures";

// ── 1. 行の生表示 ────────────────────────────────────────

test.describe("行の生表示", () => {
  test("空の付箋をクリック → 生エディタが出る", async ({ openNote }) => {
    const page = await openNote({ content: "" });
    await expect(page.locator("#editor")).toHaveCount(0);

    await enterEdit(page);
    await expect(page.locator("#editor")).toBeVisible();
  });

  test("テキスト付き付箋をクリック → その行が生エディタになる", async ({ openNote }) => {
    const page = await openNote({ content: "ただのテキスト" });

    await enterEdit(page);
    expect(await page.locator("#editor").textContent()).toBe("ただのテキスト");
  });

  test("md記法付き付箋もシングルクリックで生表示になる", async ({ openNote }) => {
    const page = await openNote({ content: "# Title" });

    await enterEdit(page);
    expect(await page.locator("#editor").textContent()).toBe("# Title");
  });

  test("エディタ外へフォーカスが外れる → 描画に戻る", async ({ openNote }) => {
    const page = await openNote({ content: "テスト" });

    await enterEdit(page);

    // relatedTarget が null になるように blur を発火する
    await page.evaluate(() => {
      const editor = document.getElementById("editor")!;
      editor.dispatchEvent(new FocusEvent("blur", { relatedTarget: null }));
    });
    await expect(page.locator("#editor")).toHaveCount(0);
    await expect(page.locator(".md-line")).toHaveText("テスト");
  });
});

// ── 2. チェックボックストグル ──────────────────────────────

test.describe("チェックボックストグル", () => {
  test("未チェックのチェックボックスをクリック → チェックが入る", async ({ openNote }) => {
    const page = await openNote({ content: "- [ ] task" });

    const checkbox = page.locator('input[type="checkbox"]');
    await expect(checkbox).not.toBeChecked();

    await checkbox.click();
    await expect(checkbox).toBeChecked();
  });

  test("チェック済みのチェックボックスをクリック → チェックが外れる", async ({ openNote }) => {
    const page = await openNote({ content: "- [x] done" });

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
    await enterEdit(page);

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

    await enterEdit(page);

    // "hello" と入力
    await page.locator("#editor").pressSequentially("hello");

    // "hello" を全選択（macOS: Meta+a, Linux: Control+a）
    const mod = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${mod}+a`);

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
    expect(await getContent(page)).toBe("[hello](https://example.com)");
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

// ── 8. ピン留めボタン ────────────────────────────────────────

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

    await enterEdit(page);

    // キャプチャをリセット
    await page.evaluate(() => { (window as any).__captured_invokes.length = 0; });

    // 単一文字入力後すぐにチェック（タイミング信頼性のため1文字のみ）
    await page.locator("#editor").press("h");

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
