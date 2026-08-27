import { test, expect, injectNoteMock, placeCaret, getContent } from "./fixtures";

const IMAGE_PATH = "images/00000000-0000-4000-8000-000000000001.png";

// data:image/svg+xml;base64, の 240x60 の矩形。ネットワーク取得を経ないため初回描画までに
// 確実に読み込みが終わっており、「生表示に入る時点では画像がすでに読み込み済み」という
// 実運用で最も多いケース（ノートを開いてから編集する）を安定して再現できる
const LOADED_IMG_SRC =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNDAiIGhlaWdodD0iNjAiPjxyZWN0IHdpZHRoPSIyNDAiIGhlaWdodD0iNjAiIGZpbGw9InJlZCIvPjwvc3ZnPg==";

test.describe("画像行の生表示中プレビュー", () => {
  // 画像のみの行（前後空白のみ）は生表示に入れない「オブジェクト」として扱う（issue #63 後続）。
  // このプレビュー自体は「テキストと画像が混在する行」向けの挙動なので、以下のフィクスチャは
  // すべてテキストと画像を混在させ、対象行が生表示に入れることを前提にしている。
  test("画像行を生表示にすると #editor の直後にプレビューが出る（幅指定も反映）", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `text ![|150](${IMAGE_PATH})` });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await placeCaret(page, 0, 0);

    await expect(page.locator(".raw-editor-preview")).toHaveCount(1);
    const isRightAfterEditor = await page.evaluate(() => {
      const ed = document.getElementById("editor")!;
      return ed.nextElementSibling?.classList.contains("raw-editor-preview") ?? false;
    });
    expect(isRightAfterEditor).toBe(true);

    const previewImg = page.locator(".raw-editor-preview img");
    await expect(previewImg).toHaveAttribute("width", "150");

    await ctx.close();
  });

  test("画像を含まない行では生表示にしてもプレビューは出ない", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "plain text" });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await placeCaret(page, 0, 0);

    await expect(page.locator(".raw-editor-preview")).toHaveCount(0);

    await ctx.close();
  });

  test("別の行へ移るとプレビューが消える", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `text0 ![](${IMAGE_PATH})\ntext1` });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await placeCaret(page, 0, 0);
    await expect(page.locator(".raw-editor-preview")).toHaveCount(1);

    await placeCaret(page, 1, 0);
    await expect(page.locator(".raw-editor-preview")).toHaveCount(0);

    await ctx.close();
  });

  test("生表示を抜ける（commit）とプレビューが消える", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `text ![](${IMAGE_PATH})` });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await placeCaret(page, 0, 0);
    await expect(page.locator(".raw-editor-preview")).toHaveCount(1);

    await page.evaluate(() => {
      document.getElementById("editor")!.dispatchEvent(new FocusEvent("blur", { relatedTarget: null }));
    });
    await expect(page.locator("#editor")).toHaveCount(0);
    await expect(page.locator(".raw-editor-preview")).toHaveCount(0);

    await ctx.close();
  });

  test("プレビューは pointer-events: none で操作対象にならない", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `text ![](${IMAGE_PATH})` }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await placeCaret(page, 0, 0);
    const previewImg = page.locator(".raw-editor-preview img");
    await expect(previewImg).toHaveCount(1);

    const pointerEvents = await previewImg.evaluate((el) => getComputedStyle(el).pointerEvents);
    expect(pointerEvents).toBe("none");

    // 実座標でのダブルクリック → pointer-events: none によりヒットテストで
    // プレビュー画像が対象にならず、open_image は発火しない
    const box = await previewImg.boundingBox();
    if (!box) throw new Error("preview image has no bounding box");
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);

    const openImageCalls = await page.evaluate(() =>
      (window as any).__captured_invokes.filter((c: any) => c.cmd === "open_image").length,
    );
    expect(openImageCalls).toBe(0);

    // 同じ座標へマウスを乗せてもリサイズハンドルは出ない
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const handleVisible = await page.evaluate(() =>
      document.querySelector(".img-resize-handle")!.classList.contains("visible"),
    );
    expect(handleVisible).toBe(false);

    await ctx.close();
  });

  test("プレビュー中央のクリックでは余白クリック扱いにならず最終行へ飛ばない", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `text ![](${IMAGE_PATH})\nline1\nline2` });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await placeCaret(page, 0, 0);
    const preview = page.locator(".raw-editor-preview");
    await expect(preview).toHaveCount(1);

    const box = await preview.boundingBox();
    if (!box) throw new Error("preview has no bounding box");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    // プレビューへの mousedown は preventDefault でフォーカス移動ごと止めるので、
    // 画像行の生表示が開いたまま変わらない（余白クリック扱いで別行へ飛ばない）
    await expect(page.locator("#editor")).toContainText("![](images/");

    const content = await getContent(page);
    expect(content).toBe(`text ![](${IMAGE_PATH})\nline1\nline2`);

    await ctx.close();
  });

  test("画像入りチェックボックス行のプレビュー: data-line が残らず checkbox はフォーカス不能", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `- [ ] ![](${IMAGE_PATH})` });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await placeCaret(page, 0, 0);
    const previewCheckbox = page.locator(".raw-editor-preview input[type=checkbox]");
    await expect(previewCheckbox).toHaveCount(1);

    // クローン内のどの子孫にも data-line / data-line-end が残っていない
    const staleDataLineCount = await page
      .locator(".raw-editor-preview [data-line], .raw-editor-preview [data-line-end]")
      .count();
    expect(staleDataLineCount).toBe(0);

    // inert によりプログラムからの focus() も無視される
    await previewCheckbox.evaluate((el) => (el as HTMLElement).focus());
    const focusedIsPreviewCheckbox = await page.evaluate(() =>
      document.activeElement === document.querySelector(".raw-editor-preview input[type=checkbox]"),
    );
    expect(focusedIsPreviewCheckbox).toBe(false);

    await ctx.close();
  });

  test("プレビューは後続行と重ならない（実測高さを clone の img に固定する）", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(
      page,
      { content: `![](${LOADED_IMG_SRC})\nline1\nline2` },
      { data_dir: null },
    );
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    // 生表示に入る前（読み込み済み）の実測高さ
    const renderedImg = page.locator('[data-line="0"] img');
    const beforeBox = await renderedImg.boundingBox();
    if (!beforeBox) throw new Error("rendered image has no bounding box");
    expect(beforeBox.height).toBeGreaterThan(0);

    await placeCaret(page, 0, 0);

    const previewImg = page.locator(".raw-editor-preview img");
    // clone 側の img に実測高さがインライン style として固定されている
    // （画像の読み込み完了タイミングに再レイアウトを委ねない）
    const styleHeight = await previewImg.evaluate((el) => (el as HTMLElement).style.height);
    expect(styleHeight).toBe(`${beforeBox.height}px`);

    // プレビュー画像の下端が後続行の上端を超えない（重ならない）
    const previewImgBox = await previewImg.boundingBox();
    const line1Box = await page.locator('[data-line="1"]').boundingBox();
    if (!previewImgBox || !line1Box) throw new Error("preview image or line1 has no bounding box");
    expect(previewImgBox.y + previewImgBox.height).toBeLessThanOrEqual(line1Box.y);

    // ラッパー自体も画像の高さをちゃんと内包している
    const previewBox = await page.locator(".raw-editor-preview").boundingBox();
    if (!previewBox) throw new Error("preview has no bounding box");
    expect(previewBox.height).toBeGreaterThanOrEqual(previewImgBox.height);

    await ctx.close();
  });

  test("ズーム時もプレビュー画像の見かけの高さが変わらない（実測値の書き戻しでズーム分を二重に掛けない）", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(
      page,
      { content: `![](${LOADED_IMG_SRC})\nline1\nline2`, zoom: 50 },
      { data_dir: null },
    );
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    // getBoundingClientRect はズーム後（画面表示）のサイズを返す
    const beforeBox = await page.locator('[data-line="0"] img').boundingBox();
    if (!beforeBox) throw new Error("rendered image has no bounding box");
    expect(beforeBox.height).toBeGreaterThan(0);

    await placeCaret(page, 0, 0);

    const previewImgBox = await page.locator(".raw-editor-preview img").boundingBox();
    if (!previewImgBox) throw new Error("preview image has no bounding box");
    // 生表示に入る前後で画面上の見かけの高さは変わらないはず。
    // ズーム前（ローカル座標）の実測値をそのまま style.height に書き込むと、祖先の
    // ズームがもう一度掛かって半分の高さになってしまう（このテストが検出したい退行）
    expect(previewImgBox.height).toBeCloseTo(beforeBox.height, 0);

    await ctx.close();
  });
});
