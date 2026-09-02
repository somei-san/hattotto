import { test, expect, enterEdit, getContent, getCaretPosition, injectNoteMock, placeCaret } from "./fixtures";

function dispatchPaste(page: import("@playwright/test").Page, plain: string, html?: string) {
  return page.evaluate(([p, h]) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", p as string);
    if (h) dt.setData("text/html", h as string);
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
  }, [plain, html] as const);
}

function dispatchImagePaste(page: import("@playwright/test").Page, bytes: number[] = [137, 80, 78, 71]) {
  return page.evaluate((b) => {
    const file = new File([new Uint8Array(b)], "pasted.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
  }, bytes);
}

test.describe("ペースト処理", () => {
  test("空の選択状態でURLペースト → リンク変換されずプレーンURL挿入", async ({ openNote }) => {
    const page = await openNote({ content: "" });
    await enterEdit(page);

    await dispatchPaste(page, "https://example.com");

    expect(await getContent(page)).toBe("https://example.com");
  });

  test("リッチテキスト（HTML含む）ペースト → Markdownに変換", async ({ openNote }) => {
    const page = await openNote({ content: "" });
    await enterEdit(page);

    await dispatchPaste(page, "bold text", "<strong>bold text</strong>");

    expect(await getContent(page)).toBe("**bold text**");
  });

  test("プレーンテキストペースト → そのまま挿入", async ({ openNote }) => {
    const page = await openNote({ content: "" });
    await enterEdit(page);

    await dispatchPaste(page, "plain text here");

    expect(await getContent(page)).toBe("plain text here");
  });

  test("単一行選択 + URLペースト → 選択範囲全体がMarkdownリンクになる", async ({ openNote }) => {
    const page = await openNote({ content: "" });
    await enterEdit(page);
    await page.keyboard.type("multi line text");
    await page.keyboard.press("Meta+a");

    await dispatchPaste(page, "https://example.com/page");

    expect(await getContent(page)).toBe("[multi line text](https://example.com/page)");
  });

  test("複数行の箇条書きペースト → 自動継続が発動せずそのまま挿入", async ({ openNote }) => {
    const page = await openNote({ content: "" });
    await enterEdit(page);

    await dispatchPaste(page, "- A\n- B\n- C");

    expect(await getContent(page)).toBe("- A\n- B\n- C");
  });

  test("HTML由来の複数行箇条書きペースト → 自動継続が発動しない", async ({ openNote }) => {
    const page = await openNote({ content: "" });
    await enterEdit(page);

    await dispatchPaste(page, "A\nB\nC", "<ul><li>A</li><li>B</li><li>C</li></ul>");

    const content = await getContent(page);
    expect(content.replace(/\n+$/, "")).toBe("- A\n- B\n- C");
  });

  test("リッチテキスト（リンク付き）ペースト → Markdownリンクに変換", async ({ openNote }) => {
    const page = await openNote({ content: "" });
    await enterEdit(page);

    await dispatchPaste(page, "click here", '<a href="https://example.com">click here</a>');

    expect(await getContent(page)).toBe("[click here](https://example.com)");
  });

  test("クリップボード画像ペースト → save_pasted_image 経由でMarkdown画像記法が挿入される", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");
    await enterEdit(page);

    await dispatchImagePaste(page);

    await expect.poll(() =>
      page.evaluate(() =>
        (window as any).__captured_invokes.filter((c: any) => c.cmd === "save_pasted_image").length,
      ),
      { timeout: 3000 },
    ).toBe(1);

    // 画像記法の直後で行が割れ、キャレットは次の（空の）行にある
    const content = await getContent(page);
    expect(content).toBe("![](images/00000000-0000-4000-8000-000000000001.png)\n");
    expect(await getCaretPosition(page)).toEqual({ line: 1, col: 0 });

    await ctx.close();
  });

  test("行中へのクリップボード画像ペースト → 画像記法の直後で行が割れる", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "hello world" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    // "hello" の直後（col=5）にキャレットを置く
    await placeCaret(page, 0, 5);

    await dispatchImagePaste(page);

    await expect.poll(() =>
      page.evaluate(() =>
        (window as any).__captured_invokes.filter((c: any) => c.cmd === "save_pasted_image").length,
      ),
      { timeout: 3000 },
    ).toBe(1);

    const content = await getContent(page);
    expect(content).toBe("hello![](images/00000000-0000-4000-8000-000000000001.png)\n world");
    // 分割後の行は先頭が空白（" world"）になる。このテストでは行番号のみを確認する
    expect((await getCaretPosition(page))?.line).toBe(1);

    await ctx.close();
  });

  test("行頭（col=0）へのクリップボード画像ペースト → 元の行全体が次の行へ押し出される", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "hello" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await placeCaret(page, 0, 0);

    await dispatchImagePaste(page);

    await expect.poll(() =>
      page.evaluate(() =>
        (window as any).__captured_invokes.filter((c: any) => c.cmd === "save_pasted_image").length,
      ),
      { timeout: 3000 },
    ).toBe(1);

    const content = await getContent(page);
    expect(content).toBe("![](images/00000000-0000-4000-8000-000000000001.png)\nhello");
    expect(await getCaretPosition(page)).toEqual({ line: 1, col: 0 });

    await ctx.close();
  });

  test("リッチテキスト内の data: 画像ペースト → save_pasted_image 経由で画像記法が挿入される", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");
    await enterEdit(page);

    await dispatchPaste(page, "caption", '<img src="data:image/png;base64,iVBORw0KGgo=" alt="cat">caption');

    await expect.poll(() =>
      page.evaluate(() =>
        (window as any).__captured_invokes.filter((c: any) => c.cmd === "save_pasted_image").length,
      ),
      { timeout: 3000 },
    ).toBe(1);

    const content = await getContent(page);
    expect(content).toBe("![cat](images/00000000-0000-4000-8000-000000000001.png)caption");

    await ctx.close();
  });

  test("リッチテキスト内の https 画像ペースト → リンクに変換され save_pasted_image は呼ばれない", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");
    await enterEdit(page);

    await dispatchPaste(page, "cat", '<img src="https://example.com/cat.png" alt="cat">');

    const content = await getContent(page);
    expect(content).toBe("[cat](https://example.com/cat.png)");

    const saveCalls = await page.evaluate(() =>
      (window as any).__captured_invokes.filter((c: any) => c.cmd === "save_pasted_image").length,
    );
    expect(saveCalls).toBe(0);

    await ctx.close();
  });

  test("画像を含まないリッチテキストペースト → Markdown に変換される", async ({ openNote }) => {
    const page = await openNote({ content: "" });
    await enterEdit(page);

    await dispatchPaste(page, "bold text", "<strong>bold text</strong>");

    expect(await getContent(page)).toBe("**bold text**");
  });

  test("1回のペースト内で同じ data: URI が複数回出てきても保存は1回だけ", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");
    await enterEdit(page);

    const html = '<img src="data:image/png;base64,iVBORw0KGgo=" alt="a">'
      + '<img src="data:image/png;base64,iVBORw0KGgo=" alt="b">';
    await dispatchPaste(page, "ab", html);

    await expect.poll(() =>
      page.evaluate(() =>
        (window as any).__captured_invokes.filter((c: any) => c.cmd === "save_pasted_image").length,
      ),
      { timeout: 3000 },
    ).toBe(1);

    const content = await getContent(page);
    expect(content).toBe(
      "![a](images/00000000-0000-4000-8000-000000000001.png)"
      + "![b](images/00000000-0000-4000-8000-000000000001.png)",
    );

    await ctx.close();
  });

  test("同じ data: URI を2回ペースト → ペーストのたびに保存し直す（重複排除はペースト単位）", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");
    await enterEdit(page);

    // 末尾に "x" を残し、行全体が画像記法だけにならないようにする（画像だけの行は
    // ペースト後に caret ではなく画像選択状態になり、続けてのペーストが caret 前提の
    // resolveEditableBounds で無視され、検証したい「ペースト単位の重複排除」に届かないため）
    const dispatch = () => dispatchPaste(page, "cat", '<img src="data:image/png;base64,iVBORw0KGgo=" alt="cat">x');

    await dispatch();
    await expect.poll(() =>
      page.evaluate(() =>
        (window as any).__captured_invokes.filter((c: any) => c.cmd === "save_pasted_image").length,
      ),
      { timeout: 3000 },
    ).toBe(1);

    await dispatch();
    await expect.poll(() =>
      page.evaluate(() =>
        (window as any).__captured_invokes.filter((c: any) => c.cmd === "save_pasted_image").length,
      ),
      { timeout: 3000 },
    ).toBe(2);

    const content = await getContent(page);
    expect(content).toBe(
      "![cat](images/00000000-0000-4000-8000-000000000001.png)x".repeat(2),
    );

    await ctx.close();
  });

  test("blob: 画像のみ（alt無し）+ text/plain が非空 → 変換結果が空にならず text が挿入される", async ({ openNote }) => {
    const page = await openNote({ content: "" });
    await enterEdit(page);

    await dispatchPaste(page, "pasted from google docs", '<img src="blob:https://docs.google.com/xyz">');

    expect(await getContent(page)).toBe("pasted from google docs");
  });

  test("画像保存待ち中に他の編集が入る → caret 位置がもう対応しないため末尾へ追記される", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "line0" }, {}, { invokeDelays: { save_pasted_image: 150 } });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");
    await enterEdit(page, 0);

    await dispatchImagePaste(page);
    // save_pasted_image の resolve を待たず、別の編集を入れる
    await page.keyboard.type("X");

    await expect.poll(() => getContent(page), { timeout: 3000 }).toBe(
      "line0X![](images/00000000-0000-4000-8000-000000000001.png)\n",
    );

    await ctx.close();
  });

  test("非同期ペースト解決前に snapshot がずれ、かつ末尾が閉じフェンス → フェンス記法を壊さず新しい行へ追記される", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "```\ncode\n```" }, {}, { invokeDelays: { save_pasted_image: 150 } });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    // 通常の編集は applyLines（ensureTrailingLineAfterClosedFence）を経由するため、閉じフェンスが
    // 最終行のままにはならない。performUndo（rawContent を直接差し替える）を使うことで、本来の
    // 「末尾行が生の閉じフェンスのまま」というフォールバックの条件を再現する
    await placeCaret(page, 1, 4); // フェンス内容行（"code"）の末尾
    await page.keyboard.type("!");

    await placeCaret(page, 3, 0); // 直前の編集で確保された末尾の空行にキャレットを置いてペースト
    await dispatchPaste(page, "caption", '<img src="data:image/png;base64,iVBORw0KGgo=" alt="cat">');
    // save_pasted_image の resolve を待たず、undo で snapshot と食い違わせる
    // （undo は applyLines を経由しないため、末尾行が生の閉じフェンスのまま戻る）
    await page.evaluate(() => (window as unknown as { performUndo(): Promise<void> }).performUndo());

    // 末尾行 "```" へそのまま連結すると閉じフェンスの記法が壊れるため、新しい行として足す
    await expect.poll(() => getContent(page), { timeout: 3000 }).toBe(
      "```\ncode\n```\n![cat](images/00000000-0000-4000-8000-000000000001.png)",
    );

    await ctx.close();
  });

  test("data: 画像の保存が失敗 → alt テキストのみ挿入されトーストが出る", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "" }, {}, { captureInvokes: true });
    await page.addInitScript(() => {
      const prevInvoke = (window as any).__TAURI__.core.invoke;
      (window as any).__TAURI__.core.invoke = async (cmd: string, args?: unknown) => {
        if (cmd === "save_pasted_image") throw new Error("disk full");
        return prevInvoke(cmd, args);
      };
    });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");
    await enterEdit(page);

    await dispatchPaste(page, "cat", '<img src="data:image/png;base64,iVBORw0KGgo=" alt="cat">');

    await expect(page.locator(".toast")).toBeVisible();

    const content = await getContent(page);
    expect(content).toBe("cat");

    await ctx.close();
  });

  test("mdView 外の選択でのペースト → 解決できず何も挿入されない（fail-closed）", async ({ openNote }) => {
    const page = await openNote({ content: "unchanged" });
    await page.evaluate(() => {
      const titlebar = document.getElementById("titlebar")!;
      const range = document.createRange();
      range.selectNodeContents(titlebar);
      range.collapse(true);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });

    await dispatchPaste(page, "should not appear");

    expect(await getContent(page)).toBe("unchanged");
  });
});
