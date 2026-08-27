import { test, expect, injectNoteMock, getContent } from "./fixtures";

const IMAGE_PATH = "images/00000000-0000-4000-8000-000000000001.png";

// asset:// URL はテスト環境では解決できないため <img alt=""> は読み込みに失敗し、
// Chromium 上でレイアウトサイズ 0 になる。
// リサイズのドラッグ量は dx（マウス移動量）だけで決まるので、実座標に依存せず
// mouseover → handle への mousedown → document への mousemove/mouseup を直接 dispatch する。
// note.js の onResizeMouseMove は取りこぼした mouseup からの自己回復のため e.buttons を見る。
// 合成 MouseEvent は buttons を明示しないと既定で 0（ボタン release 相当）になり、
// mousemove を送った瞬間に自己回復が働いてドラッグが即終了してしまうため必ず 1 を指定する。
function dragHandle([startX, endX]: [number, number]) {
  const img = document.querySelector("img")!;
  const handle = document.querySelector(".img-resize-handle")!;
  img.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: startX, clientY: 0 }));
  handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: startX, clientY: 0, buttons: 1 }));
  document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: endX, clientY: 0, buttons: 1 }));
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: endX, clientY: 0 }));
}

// index 番目の img（0始まり）を対象にドラッグする。同一行に同じ画像が複数あるケースの検証用。
function dragHandleOnImage([index, startX, endX]: [number, number, number]) {
  const img = document.querySelectorAll("img")[index];
  const handle = document.querySelector(".img-resize-handle")!;
  img.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: startX, clientY: 0 }));
  handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: startX, clientY: 0, buttons: 1 }));
  document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: endX, clientY: 0, buttons: 1 }));
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: endX, clientY: 0 }));
}

test.describe("画像のリサイズハンドル", () => {
  test("ハンドルをドラッグ → alt に |幅 が付き update_note_content が呼ばれる", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 600, height: 400 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `![](${IMAGE_PATH})` }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    // alt="" の壊れた画像は幅 0 扱い（フォールバック幅 200px）から dx=50 分だけ広がる
    await page.evaluate(dragHandle, [0, 50] as [number, number]);

    expect(await getContent(page)).toBe(`![|250](${IMAGE_PATH})`);

    await expect.poll(() =>
      page.evaluate(() =>
        (window as any).__captured_invokes.filter((c: any) => c.cmd === "update_note_content").length,
      ),
    ).toBeGreaterThan(0);
    const calls = await page.evaluate(() =>
      (window as any).__captured_invokes.filter((c: any) => c.cmd === "update_note_content"),
    );
    expect(calls.at(-1).args.content).toBe(`![|250](${IMAGE_PATH})`);

    await ctx.close();
  });

  test("既存の幅指定をドラッグで置き換える", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 600, height: 400 } });
    const page = await ctx.newPage();
    // alt は空にする。alt を非空にすると、asset:// が読み込めないテスト環境では
    // 壊れた画像アイコン + alt テキストの実測サイズが width 属性より小さくなり、
    // currentImageWidth の Math.min(width属性, 実測幅) が実測側で丸められてしまう
    await injectNoteMock(page, { content: `![|100](${IMAGE_PATH})` }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(dragHandle, [0, 50] as [number, number]);

    expect(await getContent(page)).toBe(`![|150](${IMAGE_PATH})`);

    await ctx.close();
  });

  test("縮小方向のドラッグでも幅が更新される", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 600, height: 400 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `![|150](${IMAGE_PATH})` }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(dragHandle, [50, 10] as [number, number]);

    expect(await getContent(page)).toBe(`![|110](${IMAGE_PATH})`);

    await ctx.close();
  });

  test("ズーム 50% では画面上の dx が 2 倍換算で幅に反映される", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 600, height: 400 } });
    const page = await ctx.newPage();
    await injectNoteMock(
      page,
      { content: `![|100](${IMAGE_PATH})`, zoom: 50 },
      {},
      { captureInvokes: true },
    );
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    // dx=50（画面上のマウス移動量）÷ (zoom 50% = 0.5) = canonical 幅では +100
    await page.evaluate(dragHandle, [0, 50] as [number, number]);

    expect(await getContent(page)).toBe(`![|200](${IMAGE_PATH})`);

    await ctx.close();
  });

  test("付箋が極端に狭くても、書き込まれる幅は下限（40）を下回らない", async ({ browser }) => {
    // mdView.clientWidth（上限として使う値）が下限 40 を割り込む状況を再現する。
    // 上限を下限未満のまま使うと Math.min が Math.max を上書きし、40 未満の幅を
    // 書き込んでしまう（markdown.js 側は 40 未満を無視するため、次の描画で幅が消える）。
    const ctx = await browser.newContext({ viewport: { width: 20, height: 200 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `![|100](${IMAGE_PATH})` }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(dragHandle, [0, 50] as [number, number]);

    const content = await getContent(page);
    expect(content).toBe(`![|40](${IMAGE_PATH})`);

    // markdown.js の下限（40）ちょうどなので、次の描画でも width 属性が残ることを確認する
    // （39 以下だと markdown.js が無視し width 属性が消える）
    const widthAttr = await page.evaluate(() => document.querySelector("img")!.getAttribute("width"));
    expect(widthAttr).toBe("40");

    await ctx.close();
  });

  test("画像からハンドルへ実際にポインタを移動してもドラッグが成立する（hover 経路の退行防止）", async ({ browser }) => {
    // handle は mdView の外（body 直下）に position: fixed で置かれているため、画像から
    // ハンドルへポインタが移動する際に mdView からは実際に out する。この遷移を
    // mouseleave が誤って「ホバー終了」と扱うと hoverImg が消え、mousedown してもドラッグが
    // 始まらない（dispatchEvent での直接発火では再現しない、実ポインタ移動でのみ踏む経路）。
    //
    // Playwright の locator.hover() は要素が実サイズ（bounding box が非ゼロ）でないと
    // actionable と判定しないため、alt を空にできない（alt="" は asset:// 読み込み失敗時に
    // 0 サイズになる）。alt を非空にすると逆に、
    // 壊れた画像アイコン + alt テキストの実測幅が width 属性より小さくなりうるため、
    // 期待値は note.js の currentImageWidth と同じ規則で実測して動的に求める
    const ctx = await browser.newContext({ viewport: { width: 600, height: 400 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `![説明|100](${IMAGE_PATH})` }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.locator("img").hover();
    await page.waitForFunction(() =>
      document.querySelector(".img-resize-handle")?.classList.contains("visible"),
    );

    const startWidth = await page.evaluate(() => {
      const img = document.querySelector("img")!;
      const attrWidth = parseInt(img.getAttribute("width") || "", 10);
      const rect = img.getBoundingClientRect();
      const renderedWidth = rect.width > 0 ? rect.width : null; // zoom 100% なので換算不要
      if (Number.isFinite(attrWidth) && attrWidth > 0) {
        return renderedWidth != null ? Math.min(attrWidth, renderedWidth) : attrWidth;
      }
      return renderedWidth ?? 200;
    });

    const box = await page.locator(".img-resize-handle").boundingBox();
    if (!box) throw new Error("handle has no bounding box");
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 50, y, { steps: 5 });
    await page.mouse.up();

    expect(await getContent(page)).toBe(`![説明|${Math.round(startWidth + 50)}](${IMAGE_PATH})`);

    await ctx.close();
  });

  test("同一行に同じ画像が2回 → 2個目をドラッグすると2個目だけ幅が付く", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 600, height: 400 } });
    const page = await ctx.newPage();
    const content = `![](${IMAGE_PATH}) ![](${IMAGE_PATH})`;
    await injectNoteMock(page, { content }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(dragHandleOnImage, [1, 0, 50] as [number, number, number]);

    expect(await getContent(page)).toBe(`![](${IMAGE_PATH}) ![|250](${IMAGE_PATH})`);

    await ctx.close();
  });

  test("同一行に同じ画像が2回 → 1個目をドラッグすると1個目だけ幅が付く", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 600, height: 400 } });
    const page = await ctx.newPage();
    const content = `![](${IMAGE_PATH}) ![](${IMAGE_PATH})`;
    await injectNoteMock(page, { content }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(dragHandleOnImage, [0, 0, 50] as [number, number, number]);

    expect(await getContent(page)).toBe(`![|250](${IMAGE_PATH}) ![](${IMAGE_PATH})`);

    await ctx.close();
  });

  test("ドラッグ確定後にもう一度 document へ mousemove しても content は変わらない（リスナー解除の確認）", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 600, height: 400 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `![](${IMAGE_PATH})` }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(dragHandle, [0, 50] as [number, number]);
    const afterDrag = await getContent(page);
    expect(afterDrag).toBe(`![|250](${IMAGE_PATH})`);

    // mouseup で mousemove リスナーは removeEventListener 済みのはず。
    // 取りこぼしていれば、この mousemove だけで img.style.width が動いてしまう
    await page.evaluate(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 999, clientY: 0 }));
    });

    expect(await getContent(page)).toBe(afterDrag);

    await ctx.close();
  });

  test("連続ドラッグ（1回目→renderAll→2回目）が正しく効く", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 600, height: 400 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `![](${IMAGE_PATH})` }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(dragHandle, [0, 50] as [number, number]);
    expect(await getContent(page)).toBe(`![|250](${IMAGE_PATH})`);

    // 1回目の renderAll() で作り直された新しい img/handle に対して再度ドラッグする
    await page.evaluate(dragHandle, [0, 30] as [number, number]);
    // 2回目は 1回目で書き込まれた width 属性（250）を起点に +30
    expect(await getContent(page)).toBe(`![|280](${IMAGE_PATH})`);

    await ctx.close();
  });

  test("ズーム 50% で実際のポインタ操作によるドラッグも正しく換算される", async ({ browser }) => {
    // locator.hover() は bounding box が非ゼロでないと actionable にならないので alt は非空にする。
    // 壊れた画像アイコン + alt の実測幅は width 属性とずれうるので、期待値は実測から動的に求める
    const ctx = await browser.newContext({ viewport: { width: 600, height: 400 } });
    const page = await ctx.newPage();
    await injectNoteMock(
      page,
      { content: `![説明|100](${IMAGE_PATH})`, zoom: 50 },
      {},
      { captureInvokes: true },
    );
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.locator("img").hover();
    await page.waitForFunction(() =>
      document.querySelector(".img-resize-handle")?.classList.contains("visible"),
    );

    const zoomFactor = 0.5;
    const startWidth = await page.evaluate((zf) => {
      const img = document.querySelector("img")!;
      const attrWidth = parseInt(img.getAttribute("width") || "", 10);
      const rect = img.getBoundingClientRect();
      const renderedWidth = rect.width > 0 ? rect.width / zf : null;
      if (Number.isFinite(attrWidth) && attrWidth > 0) {
        return renderedWidth != null ? Math.min(attrWidth, renderedWidth) : attrWidth;
      }
      return renderedWidth ?? 200;
    }, zoomFactor);

    const box = await page.locator(".img-resize-handle").boundingBox();
    if (!box) throw new Error("handle has no bounding box");
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 50, y, { steps: 5 });
    await page.mouse.up();

    // dx=50（画面上のマウス移動量）÷ zoomFactor(0.5) = canonical 幅では +100
    expect(await getContent(page)).toBe(`![説明|${Math.round(startWidth + 50 / zoomFactor)}](${IMAGE_PATH})`);

    await ctx.close();
  });

  test("ドラッグ中に dblclick が発火しても open_image は invoke されない", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 600, height: 400 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `![](${IMAGE_PATH})` }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      const img = document.querySelector("img")!;
      const handle = document.querySelector(".img-resize-handle")!;
      img.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 0, clientY: 0 }));
      // ドラッグ中（mouseup 前）に dblclick が届いても open_image を発火させない
      img.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 0, clientY: 0 }));
    });

    await page.waitForTimeout(100);
    const calls = await page.evaluate(() =>
      (window as any).__captured_invokes.filter((c: any) => c.cmd === "open_image"),
    );
    expect(calls.length).toBe(0);

    await ctx.close();
  });

  test("ハンドルへの mousedown のみ（移動なし）では content が変わらない", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 600, height: 400 } });
    const page = await ctx.newPage();
    const content = `![](${IMAGE_PATH})`;
    await injectNoteMock(page, { content }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      const img = document.querySelector("img")!;
      const handle = document.querySelector(".img-resize-handle")!;
      img.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 0, clientY: 0 }));
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 0, clientY: 0 }));
    });

    expect(await getContent(page)).toBe(content);

    await ctx.close();
  });

  test("リモート URL 等 data-rel-src が無効な形状の画像にはハンドルが出ない", async ({ browser }) => {
    // 書き戻し先を特定できない画像（isValidImageRelPath が弾く形状）にリサイズ UI を出すと、
    // 掴めるのにドラッグが機能しない（mousedown 側は既に isValidImageRelPath で弾いている）
    // 見た目だけの矛盾になる
    const ctx = await browser.newContext({ viewport: { width: 600, height: 400 } });
    const page = await ctx.newPage();
    const content = "![cat](https://example.com/cat.png)";
    await injectNoteMock(page, { content }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      const img = document.querySelector("img")!;
      img.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });

    const visible = await page.evaluate(() =>
      document.querySelector(".img-resize-handle")!.classList.contains("visible"),
    );
    expect(visible).toBe(false);

    await ctx.close();
  });
});
