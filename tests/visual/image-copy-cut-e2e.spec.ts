import { test, expect, injectNoteMock, getContent } from "./fixtures";

// 選択中の画像は ⌘C でコピー（選択は維持）、⌘X でコピーしたうえで確認ダイアログ無しに
// 削除できる。⌘C/⌘X はネイティブ Edit メニューがショートカットを先取りするため keydown
// では拾えず、メニュー項目も「テキスト選択が無いと無効」になる。そのため selectImage() が
// 画像に DOM 選択（Range）を張って項目を有効化し、メニュー経由の Copy/Cut を document の
// copy/cut イベントとして拾う。Playwright にはネイティブ Edit メニューが無いため、ここで
// 検証できるのは copy/cut イベントが届いた後の分岐だけ。

const IMAGE_PATH = "images/00000000-0000-4000-8000-000000000001.png";
const IMAGE_LINE = `![](${IMAGE_PATH})`;

function selectImageAtLine(page: import("@playwright/test").Page, line: number) {
  return page.evaluate(
    (l) => (window as unknown as { placeCaretAtRaw(l: number, c: number | null): void }).placeCaretAtRaw(l, null),
    line,
  );
}

/** document へ copy/cut の ClipboardEvent を dispatch する。戻り値は dispatchEvent の返り値
 * （cancelable なイベントで preventDefault() が呼ばれていれば false）。 */
function dispatchClipboardEvent(page: import("@playwright/test").Page, type: "copy" | "cut") {
  return page.evaluate((t) => {
    const ev = new ClipboardEvent(t, { bubbles: true, cancelable: true });
    return document.dispatchEvent(ev);
  }, type);
}

/** `cut_image` の戻り値を固定する。それ以外のコマンドは通常どおり処理する。 */
function mockCutImage(page: import("@playwright/test").Page, result: string | null) {
  return page.addInitScript((r) => {
    const prevInvoke = (window as any).__TAURI__.core.invoke;
    (window as any).__TAURI__.core.invoke = async (cmd: string, args?: unknown) => {
      if (cmd === "cut_image") {
        (window as any).__captured_invokes?.push({ cmd, args });
        return r;
      }
      return prevInvoke(cmd, args);
    };
  }, result);
}

function capturedCalls(page: import("@playwright/test").Page, cmd: string) {
  return page.evaluate(
    (c) => (window as any).__captured_invokes.filter((call: any) => call.cmd === c),
    cmd,
  );
}

/** 現在の DOM 選択が非collapsed で、選択中の画像（.img-selected）を覆っているか。 */
function domSelectionCoversSelectedImage(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const sel = window.getSelection();
    const img = document.querySelector("img.img-selected");
    if (!sel || !img || sel.rangeCount === 0 || sel.isCollapsed) return false;
    return sel.getRangeAt(0).intersectsNode(img);
  });
}

test.describe("選択中の画像を ⌘C / ⌘X でコピー・カットする（DOM copy/cut イベント経由）", () => {
  test("選択状態になると画像に DOM 選択（Range）が張られる", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `text0\n${IMAGE_LINE}` });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await selectImageAtLine(page, 1);

    expect(await domSelectionCoversSelectedImage(page)).toBe(true);

    await ctx.close();
  });

  test("Esc で選択解除すると DOM 選択も消える", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `text0\n${IMAGE_LINE}` });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await selectImageAtLine(page, 1);
    expect(await domSelectionCoversSelectedImage(page)).toBe(true);

    await page.keyboard.press("Escape");

    const rangeCount = await page.evaluate(() => window.getSelection()?.rangeCount ?? 0);
    expect(rangeCount).toBe(0);

    await ctx.close();
  });

  test("copy イベント → copy_image が正しい引数で invoke され preventDefault される（選択は維持）", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `text0\n${IMAGE_LINE}` }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await selectImageAtLine(page, 1);
    await expect(page.locator(".img-selected")).toHaveCount(1);

    const notCanceled = await dispatchClipboardEvent(page, "copy");
    expect(notCanceled).toBe(false); // preventDefault() された

    await expect.poll(async () => (await capturedCalls(page, "copy_image")).length).toBe(1);
    const calls = await capturedCalls(page, "copy_image");
    expect(calls[0].args).toEqual({ imagePath: IMAGE_PATH });

    // コピーは選択を解除しない
    await expect(page.locator(".img-selected")).toHaveCount(1);

    await ctx.close();
  });

  test("copy_image が失敗（reject）するとトーストが出て選択は維持される", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `text0\n${IMAGE_LINE}` }, {}, { captureInvokes: true });
    await page.addInitScript(() => {
      const prevInvoke = (window as any).__TAURI__.core.invoke;
      (window as any).__TAURI__.core.invoke = async (cmd: string, args?: unknown) => {
        if (cmd === "copy_image") throw new Error("copy_image failed");
        return prevInvoke(cmd, args);
      };
    });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await selectImageAtLine(page, 1);
    await dispatchClipboardEvent(page, "copy");

    await expect(page.locator(".toast")).toBeVisible();
    await expect(page.locator(".img-selected")).toHaveCount(1);

    await ctx.close();
  });

  test("cut イベント → cut_image が正しい引数で invoke され preventDefault され、確認なしで消えてキャレットは前の行へ", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `text0\n${IMAGE_LINE}\ntext2` }, {}, { captureInvokes: true });
    await mockCutImage(page, "text0\ntext2");
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await selectImageAtLine(page, 1);

    const notCanceled = await dispatchClipboardEvent(page, "cut");
    expect(notCanceled).toBe(false);

    await expect.poll(async () => (await capturedCalls(page, "cut_image")).length).toBe(1);
    const calls = await capturedCalls(page, "cut_image");
    expect(calls[0].args).toMatchObject({ imagePath: IMAGE_PATH, imageLine: 1, imageOccurrence: 0 });

    // 確認ダイアログ相当の待ち合わせ無しに、1 回の invoke で即座に消える
    await expect.poll(() => getContent(page)).toBe("text0\ntext2");
    await expect(page.locator(".img-selected")).toHaveCount(0);
    // Backspace と同じキャレット配置（前の行）にキャレットがあること
    const line = await page.evaluate(() => {
      const node = window.getSelection()?.anchorNode ?? null;
      return (node instanceof Element ? node : node?.parentElement)?.closest("[data-line]")?.getAttribute("data-line");
    });
    expect(line).toBe("0");

    await ctx.close();
  });

  test("cut イベントで先頭行の画像をカット → 前の行が無いので先頭に留まる", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `${IMAGE_LINE}\ntext1\ntext2` }, {}, { captureInvokes: true });
    await mockCutImage(page, "text1\ntext2");
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await selectImageAtLine(page, 0);
    await dispatchClipboardEvent(page, "cut");

    await expect.poll(() => getContent(page)).toBe("text1\ntext2");

    await ctx.close();
  });

  test("cut_image が失敗（reject）するとトーストが出て選択は維持される", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    const content = `text0\n${IMAGE_LINE}`;
    await injectNoteMock(page, { content }, {}, { captureInvokes: true });
    await page.addInitScript(() => {
      const prevInvoke = (window as any).__TAURI__.core.invoke;
      (window as any).__TAURI__.core.invoke = async (cmd: string, args?: unknown) => {
        if (cmd === "cut_image") throw new Error("cut_image failed (e.g. copy failed)");
        return prevInvoke(cmd, args);
      };
    });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await selectImageAtLine(page, 1);
    await dispatchClipboardEvent(page, "cut");

    await expect(page.locator(".toast")).toBeVisible();
    expect(await getContent(page)).toBe(content);
    await expect(page.locator(".img-selected")).toHaveCount(1);

    await ctx.close();
  });

  test("非画像のテキスト選択の copy では copy_image が割り込まず、内容も変わらない", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `text0\n${IMAGE_LINE}` }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    // 画像は選択せず、通常のテキスト行（text0）を選択する
    await page.evaluate(() => {
      const line = document.querySelector('[data-line="0"]')!;
      const range = document.createRange();
      range.selectNodeContents(line);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });

    // 実際のキー操作（selectedImage が無いので画像用ハンドラは介入しない）
    await page.keyboard.press("ControlOrMeta+c");

    const copyCalls = await capturedCalls(page, "copy_image");
    expect(copyCalls.length).toBe(0);
    // コピーはテキストを変えない
    expect(await getContent(page)).toBe(`text0\n${IMAGE_LINE}`);

    await ctx.close();
  });

  test("非画像のテキスト選択の cut では cut_image が割り込まず、選択したテキストが切り取られる", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `text0\n${IMAGE_LINE}` }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      const line = document.querySelector('[data-line="0"]')!;
      const range = document.createRange();
      range.selectNodeContents(line);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });

    await page.keyboard.press("ControlOrMeta+x");

    const cutCalls = await capturedCalls(page, "cut_image");
    expect(cutCalls.length).toBe(0);
    // 割り込まれていなければ選択していたテキストが切り取られる
    await expect.poll(() => getContent(page)).toBe(`\n${IMAGE_LINE}`);

    await ctx.close();
  });
});
