import { test, expect, enterEdit, getContent, injectNoteMock, selectMarkdownRange } from "./fixtures";

test.describe("ドラッグ&ドロップでの画像追加", () => {
  test("画像ドロップ → save_pasted_image 経由でMarkdown画像記法が対象行の末尾へ挿入される", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

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
    expect(content).toBe("![](images/00000000-0000-4000-8000-000000000001.png)");

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

    await page.evaluate(() => {
      const view = document.getElementById("markdown-view")!;
      const file1 = new File([new Uint8Array([137, 80, 78, 71, 1])], "a.png", { type: "image/png" });
      const file2 = new File([new Uint8Array([137, 80, 78, 71, 2])], "b.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file1);
      dt.items.add(file2);
      const dropEvent = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
      view.dispatchEvent(dropEvent);
    });

    await expect.poll(() =>
      page.evaluate(() => (window as any).__invoke_timeline.length),
      { timeout: 3000 },
    ).toBe(4);

    const timeline = await page.evaluate(() => (window as any).__invoke_timeline);
    expect(timeline).toEqual(["start:0", "end:0", "start:1", "end:1"]);

    // 挿入自体は2回行われている（モックは同一パスを返すため2回連結される）。
    // どちらも同じ対象行の末尾へ追記されるため連結される
    const content = await getContent(page);
    expect(content).toBe(
      "![](images/00000000-0000-4000-8000-000000000001.png)".repeat(2),
    );

    await ctx.close();
  });

  test("別行にキャレットがある状態で他行へ画像ドロップ → ドロップ先の行に挿入される", async ({ openNote }) => {
    const page = await openNote({ content: "line0\nline1\nline2" });

    // line0 に未確定の編集を作る
    await enterEdit(page, 0);
    await page.keyboard.press("End");
    await page.keyboard.type("X");

    // line0 にキャレットがあるまま、line2 の描画エリアへドロップする
    await page.evaluate(() => {
      const target = document.querySelector('[data-line="2"]')!;
      const file = new File([new Uint8Array([137, 80, 78, 71])], "dropped.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const dropEvent = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
      target.dispatchEvent(dropEvent);
    });

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

  test("テキストのドラッグ&ドロップは caret ではなくドロップ座標が指す位置へ挿入される", async ({ openNote }) => {
    const page = await openNote({ content: "line0\nline1" });
    await enterEdit(page, 0); // キャレットは line0 に残したままにする

    const point = await page.evaluate(() => {
      const el = document.querySelector('[data-line="1"]')!;
      const r = el.getBoundingClientRect();
      return { x: r.right - 1, y: r.top + r.height / 2 };
    });

    await page.evaluate(([x, y]) => {
      const dt = new DataTransfer();
      dt.setData("text/plain", "DROPPED");
      const target = document.elementFromPoint(x as number, y as number)!;
      const dropEvent = new DragEvent("drop", {
        dataTransfer: dt, bubbles: true, cancelable: true, clientX: x as number, clientY: y as number,
      });
      target.dispatchEvent(dropEvent);
    }, [point.x, point.y]);

    // caret（line0）ではなく座標が指す line1 の末尾へ挿入される
    expect(await getContent(page)).toBe("line0\nline1DROPPED");
  });

  test("座標が解決できないドロップ → 末尾へ追記される", async ({ openNote }) => {
    const page = await openNote({ content: "line0\nline1" });
    await enterEdit(page, 0);

    await page.evaluate(() => {
      const view = document.getElementById("markdown-view")!;
      const dt = new DataTransfer();
      dt.setData("text/plain", "DROPPED");
      // caretRangeFromPoint を潰し、座標解決が失敗した体でドロップする
      const original = document.caretRangeFromPoint;
      (document as any).caretRangeFromPoint = () => null;
      const dropEvent = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
      view.dispatchEvent(dropEvent);
      document.caretRangeFromPoint = original;
    });

    expect(await getContent(page)).toBe("line0\nline1DROPPED");
  });

  test("付箋内の選択をドラッグしてもコピー意味論になる（選択の自己置換 no-op にならない）", async ({ openNote }) => {
    const page = await openNote({ content: "hello world" });
    // "hello" を選択する（ドラッグ元の選択を模す）
    await selectMarkdownRange(page, 0, 0, 0, "hello".length);

    const point = await page.evaluate(() => {
      const el = document.querySelector('[data-line="0"]')!;
      const r = el.getBoundingClientRect();
      return { x: r.right - 1, y: r.top + r.height / 2 };
    });

    await page.evaluate(([x, y]) => {
      const dt = new DataTransfer();
      dt.setData("text/plain", "hello");
      const target = document.elementFromPoint(x as number, y as number)!;
      const dropEvent = new DragEvent("drop", {
        dataTransfer: dt, bubbles: true, cancelable: true, clientX: x as number, clientY: y as number,
      });
      target.dispatchEvent(dropEvent);
    }, [point.x, point.y]);

    // ドラッグ元の "hello" は残ったまま、ドロップ地点（行末）に "hello" が追加される
    // （選択をそのまま置き換えるだけの no-op にはならない）
    expect(await getContent(page)).toBe("hello worldhello");
  });
});
