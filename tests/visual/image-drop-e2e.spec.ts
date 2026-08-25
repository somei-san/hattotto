import { test, expect, enterEdit, getContent, injectNoteMock } from "./fixtures";

test.describe("ドラッグ&ドロップでの画像追加", () => {
  test("生エディタへの画像ドロップ → save_pasted_image 経由でMarkdown画像記法が挿入される", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await enterEdit(page);

    await page.evaluate(() => {
      const editor = document.getElementById("editor")!;
      const file = new File([new Uint8Array([137, 80, 78, 71])], "dropped.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const dropEvent = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
      editor.dispatchEvent(dropEvent);
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

  test("編集中でない表示領域への画像ドロップ → 末尾行に挿入される", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "line1\nline2" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    // enterEdit を呼ばない = 生表示に入っていない状態でドロップする
    await page.evaluate(() => {
      const view = document.getElementById("markdown-view")!;
      const file = new File([new Uint8Array([137, 80, 78, 71])], "dropped.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const dropEvent = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
      view.dispatchEvent(dropEvent);
    });

    await expect.poll(() =>
      page.evaluate(() =>
        (window as any).__captured_invokes.filter((c: any) => c.cmd === "save_pasted_image").length,
      ),
      { timeout: 3000 },
    ).toBe(1);

    const content = await getContent(page);
    expect(content).toBe("line1\nline2![](images/00000000-0000-4000-8000-000000000001.png)");

    await ctx.close();
  });

  test("複数ファイル同時ドロップ → 1件目の保存が終わるまで2件目の保存が始まらない（逐次性）", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "" }, {}, { captureInvokes: true });
    // save_pasted_image の1件目だけ意図的に遅延させ、2件目の呼び出しが
    // 1件目の resolve より後にしか始まらないことをタイムラインで検証する
    // （並列化されていれば2件目は1件目の遅延を待たずに始まってしまう）
    await page.addInitScript(() => {
      const prevInvoke = (window as any).__TAURI__.core.invoke;
      let saveCallCount = 0;
      (window as any).__invoke_timeline = [];
      (window as any).__TAURI__.core.invoke = async (cmd: string, args?: unknown) => {
        if (cmd !== "save_pasted_image") return prevInvoke(cmd, args);
        const idx = saveCallCount++;
        (window as any).__invoke_timeline.push(`start:${idx}`);
        if (idx === 0) await new Promise((r) => setTimeout(r, 100));
        const result = await prevInvoke(cmd, args);
        (window as any).__invoke_timeline.push(`end:${idx}`);
        return result;
      };
    });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await enterEdit(page);

    await page.evaluate(() => {
      const editor = document.getElementById("editor")!;
      const file1 = new File([new Uint8Array([137, 80, 78, 71, 1])], "a.png", { type: "image/png" });
      const file2 = new File([new Uint8Array([137, 80, 78, 71, 2])], "b.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file1);
      dt.items.add(file2);
      const dropEvent = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
      editor.dispatchEvent(dropEvent);
    });

    await expect.poll(() =>
      page.evaluate(() => (window as any).__invoke_timeline.length),
      { timeout: 3000 },
    ).toBe(4);

    const timeline = await page.evaluate(() => (window as any).__invoke_timeline);
    expect(timeline).toEqual(["start:0", "end:0", "start:1", "end:1"]);

    // 挿入自体は2回行われている（モックは同一パスを返すため2回連結される）。
    // 画像ごとに改行して次の行へ移るため、2枚目の後にも空行が残る
    const content = await getContent(page);
    expect(content).toBe(
      "![](images/00000000-0000-4000-8000-000000000001.png)\n".repeat(2),
    );

    await ctx.close();
  });

  test("生表示中の別行の描画エリアへ画像ドロップ → 生表示が commit されてから正しい行に挿入される", async ({ openNote }) => {
    const page = await openNote({ content: "line0\nline1\nline2" });

    // line0 を生表示にして未確定の編集を作る
    await enterEdit(page, 0);
    await page.locator("#editor").click();
    await page.keyboard.press("End");
    await page.keyboard.type("X");

    // line0 の生表示中のまま、生表示していない line2 へドロップする
    await page.evaluate(() => {
      const target = document.querySelector('[data-line="2"]')!;
      const file = new File([new Uint8Array([137, 80, 78, 71])], "dropped.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const dropEvent = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
      target.dispatchEvent(dropEvent);
    });

    await expect(page.locator("#editor")).toHaveCount(0);

    // drop ハンドラは非同期（save_pasted_image → renderAll → saveNow）なので、
    // dispatchEvent 自体は完了を待たない。保存が終わるまで content を待ち受ける
    await expect.poll(() => getContent(page), { timeout: 3000 }).toBe(
      "line0X\nline1\nline2![](images/00000000-0000-4000-8000-000000000001.png)",
    );
  });

  test("画像以外のファイルのみのドロップ → トーストが出て内容は変わらない", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "line1\nline2" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    // enterEdit を呼ばない = 生表示に入っていない状態でドロップする
    await page.evaluate(() => {
      const view = document.getElementById("markdown-view")!;
      const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "doc.pdf", { type: "application/pdf" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const dropEvent = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
      view.dispatchEvent(dropEvent);
    });

    await expect(page.locator(".toast")).toBeVisible();

    const invokeCount = await page.evaluate(() =>
      (window as any).__captured_invokes.filter((c: any) => c.cmd === "save_pasted_image").length,
    );
    expect(invokeCount).toBe(0);

    const content = await getContent(page);
    expect(content).toBe("line1\nline2");

    await ctx.close();
  });

  test("生エディタ内のテキストドラッグ移動は退行しない", async ({ openNote }) => {
    const page = await openNote({ content: "" });

    await enterEdit(page);

    await page.evaluate(() => {
      const editor = document.getElementById("editor")!;
      const dt = new DataTransfer();
      dt.setData("text/plain", "dragged text");
      const dropEvent = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
      editor.dispatchEvent(dropEvent);
    });

    const content = await getContent(page);
    expect(content).toBe("dragged text");
  });
});
