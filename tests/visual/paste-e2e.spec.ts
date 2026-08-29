import { test, expect, enterEdit, getContent, injectNoteMock, placeCaret } from "./fixtures";

test.describe("ペースト処理", () => {
  test("空の選択状態でURLペースト → リンク変換されずプレーンURL挿入", async ({ openNote }) => {
    const page = await openNote({ content: "" });

    await enterEdit(page);

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

    const content = await getContent(page);
    expect(content).toBe("https://example.com");
  });

  test("リッチテキスト（HTML含む）ペースト → Markdownに変換", async ({ openNote }) => {
    const page = await openNote({ content: "" });

    await enterEdit(page);

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

    const content = await getContent(page);
    expect(content).toBe("**bold text**");
  });

  test("プレーンテキストペースト → そのまま挿入", async ({ openNote }) => {
    const page = await openNote({ content: "" });

    await enterEdit(page);

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

    const content = await getContent(page);
    expect(content).toBe("plain text here");
  });

  test("複数行選択 + URLペースト → 選択範囲全体がMarkdownリンクになる", async ({ openNote }) => {
    const page = await openNote({ content: "" });

    await enterEdit(page);

    // テキストを入力して全選択。⌘A は付箋全体を選択する（selectAllNote）ため、生エディタ内
    // だけを選択するにはここでは Range を直接張る
    await page.locator("#editor").pressSequentially("multi line text");
    await page.evaluate(() => {
      const ed = document.getElementById("editor")!;
      const range = document.createRange();
      range.selectNodeContents(ed);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });

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

    const content = await getContent(page);
    expect(content).toBe("[multi line text](https://example.com/page)");
  });

  test("複数行の箇条書きペースト → 自動継続が発動せずそのまま挿入", async ({ openNote }) => {
    const page = await openNote({ content: "" });

    await enterEdit(page);

    await page.evaluate(() => {
      const editor = document.getElementById("editor")!;
      const dt = new DataTransfer();
      dt.setData("text/plain", "- A\n- B\n- C");
      const pasteEvent = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(pasteEvent);
    });

    const content = await getContent(page);
    expect(content).toBe("- A\n- B\n- C");
  });

  test("HTML由来の複数行箇条書きペースト → 自動継続が発動しない", async ({ openNote }) => {
    const page = await openNote({ content: "" });

    await enterEdit(page);

    await page.evaluate(() => {
      const editor = document.getElementById("editor")!;
      const dt = new DataTransfer();
      dt.setData("text/plain", "A\nB\nC");
      dt.setData("text/html", "<ul><li>A</li><li>B</li><li>C</li></ul>");
      const pasteEvent = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(pasteEvent);
    });

    const content = await getContent(page);
    expect(content.replace(/\n+$/, "")).toBe("- A\n- B\n- C");
  });

  test("リッチテキスト（リンク付き）ペースト → Markdownリンクに変換", async ({ openNote }) => {
    const page = await openNote({ content: "" });

    await enterEdit(page);

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

    const content = await getContent(page);
    expect(content).toBe("[click here](https://example.com)");
  });

  test("クリップボード画像ペースト → save_pasted_image 経由でMarkdown画像記法が挿入される", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await enterEdit(page);

    await page.evaluate(() => {
      const editor = document.getElementById("editor")!;
      const file = new File([new Uint8Array([137, 80, 78, 71])], "pasted.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const pasteEvent = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(pasteEvent);
    });

    await expect.poll(() =>
      page.evaluate(() =>
        (window as any).__captured_invokes.filter((c: any) => c.cmd === "save_pasted_image").length,
      ),
      { timeout: 3000 },
    ).toBe(1);

    // 画像記法の直後で行が割れ、キャレットは次の（空の）行にある
    const content = await getContent(page);
    expect(content).toBe("![](images/00000000-0000-4000-8000-000000000001.png)\n");

    const activeLine = await page.evaluate(() => document.getElementById("editor")!.textContent);
    expect(activeLine).toBe("");

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

    await page.evaluate(() => {
      const editor = document.getElementById("editor")!;
      const file = new File([new Uint8Array([137, 80, 78, 71])], "pasted.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const pasteEvent = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(pasteEvent);
    });

    await expect.poll(() =>
      page.evaluate(() =>
        (window as any).__captured_invokes.filter((c: any) => c.cmd === "save_pasted_image").length,
      ),
      { timeout: 3000 },
    ).toBe(1);

    const content = await getContent(page);
    expect(content).toBe("hello![](images/00000000-0000-4000-8000-000000000001.png)\n world");

    const activeLine = await page.evaluate(() => document.getElementById("editor")!.textContent);
    expect(activeLine).toBe(" world");

    await ctx.close();
  });

  test("行頭（col=0）へのクリップボード画像ペースト → 元の行全体が次の行へ押し出される", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "hello" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await placeCaret(page, 0, 0);

    await page.evaluate(() => {
      const editor = document.getElementById("editor")!;
      const file = new File([new Uint8Array([137, 80, 78, 71])], "pasted.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const pasteEvent = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(pasteEvent);
    });

    await expect.poll(() =>
      page.evaluate(() =>
        (window as any).__captured_invokes.filter((c: any) => c.cmd === "save_pasted_image").length,
      ),
      { timeout: 3000 },
    ).toBe(1);

    const content = await getContent(page);
    expect(content).toBe("![](images/00000000-0000-4000-8000-000000000001.png)\nhello");

    const activeLine = await page.evaluate(() => document.getElementById("editor")!.textContent);
    expect(activeLine).toBe("hello");

    await ctx.close();
  });

  test("リッチテキスト内の data: 画像ペースト → save_pasted_image 経由で画像記法が挿入される", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await enterEdit(page);

    await page.evaluate(() => {
      const editor = document.getElementById("editor")!;
      const dt = new DataTransfer();
      dt.setData("text/plain", "caption");
      dt.setData(
        "text/html",
        '<img src="data:image/png;base64,iVBORw0KGgo=" alt="cat">caption',
      );
      const pasteEvent = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(pasteEvent);
    });

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

    await page.evaluate(() => {
      const editor = document.getElementById("editor")!;
      const dt = new DataTransfer();
      dt.setData("text/plain", "cat");
      dt.setData("text/html", '<img src="https://example.com/cat.png" alt="cat">');
      const pasteEvent = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(pasteEvent);
    });

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

    const content = await getContent(page);
    expect(content).toBe("**bold text**");
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
    await page.evaluate((h) => {
      const editor = document.getElementById("editor")!;
      const dt = new DataTransfer();
      dt.setData("text/plain", "ab");
      dt.setData("text/html", h);
      const pasteEvent = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(pasteEvent);
    }, html);

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

    const dispatchPaste = () => page.evaluate(() => {
      const editor = document.getElementById("editor")!;
      const dt = new DataTransfer();
      dt.setData("text/plain", "cat");
      dt.setData("text/html", '<img src="data:image/png;base64,iVBORw0KGgo=" alt="cat">');
      const pasteEvent = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(pasteEvent);
    });

    await dispatchPaste();
    await expect.poll(() =>
      page.evaluate(() =>
        (window as any).__captured_invokes.filter((c: any) => c.cmd === "save_pasted_image").length,
      ),
      { timeout: 3000 },
    ).toBe(1);

    await dispatchPaste();
    await expect.poll(() =>
      page.evaluate(() =>
        (window as any).__captured_invokes.filter((c: any) => c.cmd === "save_pasted_image").length,
      ),
      { timeout: 3000 },
    ).toBe(2);

    const content = await getContent(page);
    expect(content).toBe(
      "![cat](images/00000000-0000-4000-8000-000000000001.png)".repeat(2),
    );

    await ctx.close();
  });

  test("blob: 画像のみ（alt無し）+ text/plain が非空 → 変換結果が空にならず text が挿入される", async ({ openNote }) => {
    const page = await openNote({ content: "" });

    await enterEdit(page);

    await page.evaluate(() => {
      const editor = document.getElementById("editor")!;
      const dt = new DataTransfer();
      dt.setData("text/plain", "pasted from google docs");
      dt.setData("text/html", '<img src="blob:https://docs.google.com/xyz">');
      const pasteEvent = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(pasteEvent);
    });

    const content = await getContent(page);
    expect(content).toBe("pasted from google docs");
  });

  test("data: 画像を含むペースト中に生表示が閉じる → fallbackLine（元の行）へ書き戻される", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "line0" }, {}, { captureInvokes: true });
    // save_pasted_image を遅延させ、resolve 前に生表示を閉じる猶予を作る
    await page.addInitScript(() => {
      const prevInvoke = (window as any).__TAURI__.core.invoke;
      (window as any).__TAURI__.core.invoke = async (cmd: string, args?: unknown) => {
        if (cmd === "save_pasted_image") {
          await new Promise((r) => setTimeout(r, 100));
        }
        return prevInvoke(cmd, args);
      };
    });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await enterEdit(page, 0);

    await page.evaluate(() => {
      const editor = document.getElementById("editor")!;
      const dt = new DataTransfer();
      dt.setData("text/plain", "cat");
      dt.setData("text/html", '<img src="data:image/png;base64,iVBORw0KGgo=" alt="cat">');
      const pasteEvent = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(pasteEvent);
    });

    // save_pasted_image の resolve を待たず、生表示を閉じて確定させる
    // （relatedTarget が null になるように blur を発火し、生表示のクローズ処理を確定させる）
    await page.evaluate(() => {
      const editor = document.getElementById("editor")!;
      editor.dispatchEvent(new FocusEvent("blur", { relatedTarget: null }));
    });
    await expect(page.locator("#editor")).toHaveCount(0);

    await expect.poll(() => getContent(page), { timeout: 3000 }).toBe(
      "line0![cat](images/00000000-0000-4000-8000-000000000001.png)",
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

    await page.evaluate(() => {
      const editor = document.getElementById("editor")!;
      const dt = new DataTransfer();
      dt.setData("text/plain", "cat");
      dt.setData("text/html", '<img src="data:image/png;base64,iVBORw0KGgo=" alt="cat">');
      const pasteEvent = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(pasteEvent);
    });

    await expect(page.locator(".toast")).toBeVisible();

    const content = await getContent(page);
    expect(content).toBe("cat");

    await ctx.close();
  });
});
