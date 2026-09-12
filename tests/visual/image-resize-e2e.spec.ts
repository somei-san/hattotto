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

    // dblclick ハンドラは dispatch 中に同期的に invoke を呼ぶ（呼ぶなら）ので、dispatch が
    // 返った時点で呼び出し記録は確定している
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

// 選択中は hover の有無に関係なく常にハンドルを出す。ハンドルの表示・位置合わせ・ドラッグ可否を見る。
test.describe("選択中は常にリサイズハンドルを表示する", () => {
  const handleVisible = (page: import("@playwright/test").Page) =>
    page.evaluate(() => document.querySelector(".img-resize-handle")!.classList.contains("visible"));

  test("選択後にマウスが画像の外へ出てもハンドルは visible のまま", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `![](${IMAGE_PATH})` });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      const img = document.querySelector("img")!;
      img.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      img.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    });
    expect(await handleVisible(page)).toBe(true);

    // mdView を完全に離れる（relatedTarget が画像でもハンドルでもない）。選択中はこの遷移でも隠れない
    await page.evaluate(() => {
      document.getElementById("markdown-view")!.dispatchEvent(
        new MouseEvent("mouseleave", { relatedTarget: document.body }),
      );
    });

    expect(await handleVisible(page)).toBe(true);

    await ctx.close();
  });

  test("未選択の画像は、hover を離れるとハンドルが消える", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `![](${IMAGE_PATH})` });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      document.querySelector("img")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(await handleVisible(page)).toBe(true);

    await page.evaluate(() => {
      document.getElementById("markdown-view")!.dispatchEvent(
        new MouseEvent("mouseleave", { relatedTarget: document.body }),
      );
    });

    expect(await handleVisible(page)).toBe(false);

    await ctx.close();
  });

  test("選択解除でハンドルも消える（画像を hover していない場合）", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `![](${IMAGE_PATH})` });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.click("#markdown-view");
    await expect(page.locator(".img-selected")).toHaveCount(1);
    expect(await handleVisible(page)).toBe(true);

    await page.keyboard.press("Escape");

    await expect(page.locator(".img-selected")).toHaveCount(0);
    expect(await handleVisible(page)).toBe(false);

    await ctx.close();
  });

  test("hover したまま選択した画像からキーボードでキャレットを移すと、ハンドルは残らない", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `![](${IMAGE_PATH})\nafter` });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    // mouseover で hover が記録された状態のまま選択する。マウスはその後動かさない
    // （hover の記録は mouseover でしか更新されないので、古いまま残る）
    await page.evaluate(() => {
      const img = document.querySelector("img")!;
      img.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      img.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    });
    await expect(page.locator(".img-selected")).toHaveCount(1);
    expect(await handleVisible(page)).toBe(true);

    await page.keyboard.press("ArrowDown");

    await expect(page.locator(".img-selected")).toHaveCount(0);
    expect(await handleVisible(page)).toBe(false);

    await ctx.close();
  });

  test("選択中に mdView をスクロールしてもハンドルは消えず、画像の右下に追従する", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 400 } });
    const page = await ctx.newPage();
    const before = Array.from({ length: 20 }, (_, i) => `line${i}`);
    const after = Array.from({ length: 20 }, (_, i) => `line${i + 20}`);
    const content = [...before, `![|100](${IMAGE_PATH})`, ...after].join("\n");
    await injectNoteMock(page, { content });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    // 画像を可視範囲の中ほどに置く（端に寄せると小さなスクロールで見切れて次のアサートが
    // 「消える」側と区別できなくなるため）
    await page.evaluate(() => {
      const mdView = document.getElementById("markdown-view")!;
      const block = document.querySelector("img")!.closest<HTMLElement>("[data-line]")!;
      mdView.scrollTop = block.offsetTop - mdView.clientHeight / 2;
    });
    await page.evaluate(() => {
      document.querySelector("img")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    });
    await expect(page.locator(".img-selected")).toHaveCount(1);
    expect(await handleVisible(page)).toBe(true);

    await page.evaluate(() => {
      const mdView = document.getElementById("markdown-view")!;
      mdView.scrollTop -= 30;
      mdView.dispatchEvent(new Event("scroll"));
    });

    expect(await handleVisible(page)).toBe(true);
    const [imgRect, handleRect] = await page.evaluate(() => [
      document.querySelector("img")!.getBoundingClientRect().toJSON(),
      document.querySelector(".img-resize-handle")!.getBoundingClientRect().toJSON(),
    ]);
    // positionHandle は画像の右下（rect.right/rect.bottom）から 5px 内側にハンドルの左上を置く
    expect(Math.abs(handleRect.left - (imgRect.right - 5))).toBeLessThanOrEqual(2);
    expect(Math.abs(handleRect.top - (imgRect.bottom - 5))).toBeLessThanOrEqual(2);

    await ctx.close();
  });

  test("選択中の画像を mdView の可視範囲外までスクロールすると、ハンドルは mdView の外に取り残されず隠れる", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 150 } });
    const page = await ctx.newPage();
    const lines = Array.from({ length: 30 }, (_, i) => `line${i}`);
    const content = [...lines, `![|100](${IMAGE_PATH})`].join("\n");
    await injectNoteMock(page, { content });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => document.querySelector("img")!.scrollIntoView());
    await page.evaluate(() => {
      document.querySelector("img")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    });
    await expect(page.locator(".img-selected")).toHaveCount(1);
    expect(await handleVisible(page)).toBe(true);

    // 画像が見えなくなるまで先頭へ戻す
    await page.evaluate(() => {
      const mdView = document.getElementById("markdown-view")!;
      mdView.scrollTop = 0;
      mdView.dispatchEvent(new Event("scroll"));
    });

    expect(await handleVisible(page)).toBe(false);
    // 選択そのものは維持したまま（再びスクロールすればハンドルは戻る）
    await expect(page.locator(".img-selected")).toHaveCount(1);

    await ctx.close();
  });

  test("付箋の幅が変わって選択中の画像が可視範囲外へ押し出されたら、ハンドルも取り残されず消える", async ({ browser }) => {
    // 折り返しのある長い行の下に画像を置く。付箋を狭めると折り返し行数が増えて画像が下へ
    // 押し出され、mdView の可視範囲（高さ固定）から外れる。ウィンドウのネイティブなリサイズ
    // 通知（appWindow.onResized）はテストのモックが no-op のため使えないので、webview の
    // window resize イベントで refreshHandle が呼ばれることを確認する
    const ctx = await browser.newContext({ viewport: { width: 400, height: 150 } });
    const page = await ctx.newPage();
    const content = `${"a".repeat(200)}\n![](${IMAGE_PATH})`;
    await injectNoteMock(page, { content });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => document.querySelector("img")!.scrollIntoView());
    await page.evaluate(() => {
      document.querySelector("img")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    });
    await expect(page.locator(".img-selected")).toHaveCount(1);
    expect(await handleVisible(page)).toBe(true);

    const scrollTopBefore = await page.evaluate(() => document.getElementById("markdown-view")!.scrollTop);
    await page.setViewportSize({ width: 80, height: 150 });
    // scrollTop 自体が変わって scroll イベント経由で隠れたのではなく、window の resize
    // イベント経由で隠れたことを確認する（scrollTop が動いていれば別経路と区別できない）
    expect(await page.evaluate(() => document.getElementById("markdown-view")!.scrollTop)).toBe(scrollTopBefore);
    await page.waitForFunction(() => !document.querySelector(".img-resize-handle")!.classList.contains("visible"));

    // 選択そのものは維持したまま（幅を戻せばハンドルは復帰する）
    await expect(page.locator(".img-selected")).toHaveCount(1);

    await ctx.close();
  });

  test("選択中の画像は hover を経ずハンドルからドラッグでリサイズできる。確定後もハンドルと選択枠が残る", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 600, height: 400 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `![](${IMAGE_PATH})` }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    // mouseover を経由せずクリックだけで選択する（ハンドルは選択由来で出ているはず）
    await page.evaluate(() => {
      document.querySelector("img")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    });
    await expect(page.locator(".img-selected")).toHaveCount(1);
    expect(await handleVisible(page)).toBe(true);

    await page.evaluate(([startX, endX]) => {
      const handle = document.querySelector(".img-resize-handle")!;
      handle.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, clientX: startX, clientY: 0, buttons: 1 }),
      );
      document.dispatchEvent(
        new MouseEvent("mousemove", { bubbles: true, clientX: endX, clientY: 0, buttons: 1 }),
      );
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: endX, clientY: 0 }));
    }, [0, 50]);

    expect(await getContent(page)).toBe(`![|250](${IMAGE_PATH})`);
    await expect(page.locator(".img-selected")).toHaveCount(1);
    expect(await handleVisible(page)).toBe(true);

    await ctx.close();
  });

  test("選択中の画像と別の画像を hover しても、ハンドルは選択中の画像に留まりそちらだけがリサイズされる", async ({ browser }) => {
    // ハンドルの表示位置（選択優先）と mousedown のリサイズ対象（handleTargetImg）は
    // 常に同じ画像を指す必要がある。hover 側が表示を奪うと、見えている画像と違う画像が
    // 黙ってリサイズされてしまう
    const ctx = await browser.newContext({ viewport: { width: 600, height: 400 } });
    const page = await ctx.newPage();
    const content = `![](${IMAGE_PATH})\n![](${IMAGE_PATH})`;
    await injectNoteMock(page, { content }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      document.querySelectorAll("img")[0].dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true, cancelable: true }),
      );
    });
    await expect(page.locator(".img-selected")).toHaveCount(1);

    // 別の（未選択の）画像を hover する
    await page.evaluate(() => {
      document.querySelectorAll("img")[1].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });

    // ハンドルは選択中の 1 個目の画像に留まる（2 個目の画像へ動かない）。
    // 2 枚は別行で x 座標が同じになるため、行ごとに違う y 座標（画像下端）側で判定する
    const [firstBottom, secondBottom] = await page.evaluate(() => [
      document.querySelectorAll("img")[0].getBoundingClientRect().bottom,
      document.querySelectorAll("img")[1].getBoundingClientRect().bottom,
    ]);
    const handleTop = await page.evaluate(() =>
      parseFloat((document.querySelector(".img-resize-handle") as HTMLElement).style.top),
    );
    expect(Math.abs(handleTop - (firstBottom - 5))).toBeLessThanOrEqual(2);
    expect(Math.abs(handleTop - (secondBottom - 5))).toBeGreaterThan(5);

    await page.evaluate(([startX, endX]) => {
      const handle = document.querySelector(".img-resize-handle")!;
      handle.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, clientX: startX, clientY: 0, buttons: 1 }),
      );
      document.dispatchEvent(
        new MouseEvent("mousemove", { bubbles: true, clientX: endX, clientY: 0, buttons: 1 }),
      );
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: endX, clientY: 0 }));
    }, [0, 50]);

    // 1 個目（選択中）だけに幅が付き、2 個目（hover しただけ）は無指定のまま
    expect(await getContent(page)).toBe(`![|250](${IMAGE_PATH})\n![](${IMAGE_PATH})`);

    await ctx.close();
  });
});
