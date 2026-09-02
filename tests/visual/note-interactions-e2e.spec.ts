import { test, expect, injectNoteMock, enterEdit, placeCaret, getContent } from "./fixtures";

// ── 1. キャレット配置 ────────────────────────────────────
// #markdown-view 自体が contenteditable なので「生表示に入る／描画に戻る」という別状態は
// 無い。クリック・placeCaretAtRaw がキャレットを置き、mdView がフォーカスを持つことだけを確認する。

test.describe("キャレット配置", () => {
  test("空の付箋をクリック → mdView にフォーカスが移る", async ({ openNote }) => {
    const page = await openNote({ content: "" });
    await page.click("#markdown-view");
    const focused = await page.evaluate(() => document.activeElement?.id);
    expect(focused).toBe("markdown-view");
  });

  test("テキスト付き付箋をクリック → その行にキャレットが置かれる", async ({ openNote }) => {
    const page = await openNote({ content: "ただのテキスト" });

    await placeCaret(page, 0);
    const inLine = await page.evaluate(() =>
      document.querySelector('[data-line="0"]')?.contains(window.getSelection()?.anchorNode ?? null),
    );
    expect(inLine).toBe(true);
  });

  test("md記法付き付箋もクリックでキャレットが置かれ、内容は変わらない", async ({ openNote }) => {
    const page = await openNote({ content: "# Title" });

    await placeCaret(page, 0);
    expect(await getContent(page)).toBe("# Title");
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

// ── 4. ペースト（URLリンク変換） ─────────────────────────
// caret へのペースト合流（beforeinput の insertFromPaste）は未実装で、document の
// paste リスナーが常に preventDefault する（fail-closed）ため fixme にしている。

// ── 5. ピン留めボタン ────────────────────────────────────────

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

// ── 6. ボタン表示/非表示設定 ────────────────────────────────

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

// ── 7. 自動保存（デバウンス） ───────────────────────────────

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
    await page.locator("#markdown-view").press("h");

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
