import { test, expect, getContent, injectNoteMock, selectMarkdownRange } from "./fixtures";

const IMAGE_PATH = "images/00000000-0000-4000-8000-000000000001.png";
const IMAGE_LINE = `![](${IMAGE_PATH})`;

// 行またぎ選択（および描画上の単一行選択。削除系と同じ resolveDeletableBounds の対象）がある
// 状態でのタイピング・ペーストによる置換系の操作。削除 splice と挿入テキストを 1 回の
// applyLines にまとめる（commitSelectionReplacement）ため、undo は 1 手で「選択+入力前」に戻る。
// 削除だけ（挿入テキストなし）の経路は selection-edit-e2e.spec.ts を参照。

function dispatchPaste(page: import("@playwright/test").Page, plain: string, html?: string) {
  return page.evaluate(([p, h]) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", p as string);
    if (h) dt.setData("text/html", h as string);
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
  }, [plain, html] as const);
}

test.describe("行またぎ選択 + タイピングで置換される", () => {
  test("装飾記法・リストマーカーを含む範囲が置換され、undo 1 手で選択+入力前に戻る", async ({ openNote }) => {
    const content = ["# Heading", "**bold** text", "- item one", "- item two", "tail"].join("\n");
    const page = await openNote({ content });

    // 2行目（"bold text" の先頭）〜4行目（"item two" の "item " の直後）を選択
    await selectMarkdownRange(page, 1, 0, 3, "item ".length);
    await page.keyboard.press("x");

    expect(await getContent(page)).toBe("# Heading\nxtwo\ntail");

    // scheduleSave() の 300ms デバウンスが確定し、history.commit が積まれるのを待つ
    await page.waitForTimeout(400);
    await page.evaluate(() => (window as unknown as { performUndo(): Promise<void> }).performUndo());

    expect(await getContent(page)).toBe(content);
  });

  test("キャレットは挿入した文字の直後に置かれ、生表示のまま続けて入力できる", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef" });

    await selectMarkdownRange(page, 0, 0, 1, "def".length);
    await page.keyboard.press("x");
    await page.keyboard.press("y"); // 続けての入力はそのままキャレット位置へ入る

    expect(await getContent(page)).toBe("xy");
  });
});

test.describe("単一行選択 + タイピングで全置換される", () => {
  test("⌘A → 1 行付箋への入力で全置換される", async ({ openNote }) => {
    const page = await openNote({ content: "hello" });

    await page.keyboard.press("Meta+a");
    await page.keyboard.press("x");

    expect(await getContent(page)).toBe("x");
  });
});

test.describe("行またぎ選択 + ペーストで置換される", () => {
  test("プレーンテキストペーストで置換される", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef\nghi" });

    await selectMarkdownRange(page, 0, 1, 1, 1); // "a|bc" 〜 "d|ef"（可視オフセット 1）を選択
    await dispatchPaste(page, "XY");

    expect(await getContent(page)).toBe("aXYef\nghi");
  });

  test("複数行テキストのペーストで置換され、行が展開される", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef\nghi" });

    await selectMarkdownRange(page, 0, 1, 1, 1);
    await dispatchPaste(page, "X\nY");

    expect(await getContent(page)).toBe("aX\nYef\nghi");
  });

  test("リッチテキスト（HTML 含む）ペーストは nodeToMd 変換を経由して置換される", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef" });

    await selectMarkdownRange(page, 0, 0, 1, "def".length); // 全体を選択
    await dispatchPaste(page, "bold text", "<strong>bold text</strong>");

    expect(await getContent(page)).toBe("**bold text**");
  });

  test("クリップボード画像ペーストは save_pasted_image の非同期解決を待ってから置換される", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef" });

    await selectMarkdownRange(page, 0, 0, 1, "def".length); // 全体を選択
    await page.evaluate(() => {
      const dt = new DataTransfer();
      const file = new File([new Uint8Array([137, 80, 78, 71])], "pasted.png", { type: "image/png" });
      dt.items.add(file);
      const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      document.dispatchEvent(ev);
    });

    await expect.poll(() => getContent(page)).toBe(
      "![](images/00000000-0000-4000-8000-000000000001.png)\n",
    );
  });
});

test.describe("Shift・⌥ 付き文字入力でも置換される", () => {
  test("Shift 付き文字（大文字）で置換される", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef" });

    await selectMarkdownRange(page, 0, 0, 1, "def".length);
    await page.keyboard.press("Shift+X");

    expect(await getContent(page)).toBe("X");
  });

  test("⌥ 付き文字（例: ⌥8 → •）で置換される", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef" });

    await selectMarkdownRange(page, 0, 0, 1, "def".length);
    // ⌥8 の実キー入力は OS のキーボードレイアウトに依存し、かつ置換はブラウザが発火する
    // 実際の（isTrusted な）beforeinput 経由でのみ起きるため、合成 keydown では再現できない。
    // 変換済みの文字が挿入される beforeinput(insertText) を直接 dispatch して、
    // ディスパッチャがその inputType をどう扱うかを検証する
    await page.evaluate(() => {
      const view = document.getElementById("markdown-view")!;
      const ev = new InputEvent("beforeinput", {
        inputType: "insertText", data: "•", bubbles: true, cancelable: true,
      });
      view.dispatchEvent(ev);
    });

    expect(await getContent(page)).toBe("•");
  });
});

test.describe("URL ペーストのリンク化（描画側選択）", () => {
  test("選択テキスト + URL ペーストで [選択テキスト](URL) に置換される", async ({ openNote }) => {
    const page = await openNote({ content: "hello world" });

    await selectMarkdownRange(page, 0, 0, 0, "hello".length);
    await dispatchPaste(page, "https://example.com");

    expect(await getContent(page)).toBe("[hello](https://example.com) world");
  });

  test("行またぎ選択への URL ペーストはリンク化せず素の URL 挿入に落ちる（改行入りラベルで壊れることを防ぐ）", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef" });

    await selectMarkdownRange(page, 0, 0, 1, "def".length); // 全体を選択（行またぎ）
    await dispatchPaste(page, "https://example.com");

    expect(await getContent(page)).toBe("https://example.com");
  });

  test("URL に `)` を含む場合はリンク化せず素の URL 挿入に落ちる（リンクの終端と衝突するため）", async ({ openNote }) => {
    const page = await openNote({ content: "hello world" });

    await selectMarkdownRange(page, 0, 0, 0, "hello".length);
    await dispatchPaste(page, "https://example.com/foo(bar)");

    expect(await getContent(page)).toBe("https://example.com/foo(bar) world");
  });

  test("選択テキストに `]` を含む場合はラベルから除去したうえでリンク化する", async ({ openNote }) => {
    const page = await openNote({ content: "he]lo world" });

    await selectMarkdownRange(page, 0, 0, 0, "he]lo".length);
    await dispatchPaste(page, "https://example.com");

    expect(await getContent(page)).toBe("[helo](https://example.com) world");
  });
});

test.describe("画像行フォールバック（削除後キャレット行が画像のみになる）", () => {
  test("プレーンテキストが零幅 bounds で再 splice され、削除だけで捨てられない", async ({ openNote }) => {
    const page = await openNote({ content: `abc\n${IMAGE_LINE}\ndef` });

    await selectMarkdownRange(page, 0, 0, 1, 0); // "abc\n" だけを画像行の手前まで選択
    await dispatchPaste(page, "XY");

    expect(await getContent(page)).toBe(`XY${IMAGE_LINE}\ndef`);
  });
});

test.describe("ペーストの undo 手数", () => {
  test("プレーンテキストペーストは undo 1 手で選択+ペースト前に戻る", async ({ openNote }) => {
    const content = "abc\ndef\nghi";
    const page = await openNote({ content });

    await selectMarkdownRange(page, 0, 1, 1, 1);
    await dispatchPaste(page, "XY");
    expect(await getContent(page)).toBe("aXYef\nghi");

    await page.waitForTimeout(400);
    await page.evaluate(() => (window as unknown as { performUndo(): Promise<void> }).performUndo());

    expect(await getContent(page)).toBe(content);
  });

  // save_pasted_image の解決に 400ms かける。削除の scheduleSave（300ms デバウンス）が
  // この待ち時間の途中で先に切れると「削除だけ」を history へ積んでしまい、undo が 2 手に割れる
  test("クリップボード画像ペースト（save_pasted_image の解決に 400ms かかる）も undo 1 手で選択+ペースト前に戻る", async ({ browser }) => {
    const content = "abc\ndef";
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content }, {}, { invokeDelays: { save_pasted_image: 400 } });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await selectMarkdownRange(page, 0, 0, 1, "def".length);
    await page.evaluate(() => {
      const dt = new DataTransfer();
      const file = new File([new Uint8Array([137, 80, 78, 71])], "pasted.png", { type: "image/png" });
      dt.items.add(file);
      const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      document.dispatchEvent(ev);
    });

    await expect.poll(() => getContent(page), { timeout: 3000 }).toBe(
      "![](images/00000000-0000-4000-8000-000000000001.png)\n",
    );

    await page.waitForTimeout(400);
    await page.evaluate(() => (window as unknown as { performUndo(): Promise<void> }).performUndo());

    expect(await getContent(page)).toBe(content);

    await ctx.close();
  });
});

test.describe("置換を起こさない操作", () => {
  test("⌘/Ctrl 付きキーは置換しない（既定の編集操作に任せる）", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef" });

    await selectMarkdownRange(page, 0, 0, 1, "def".length);
    await page.keyboard.press("Meta+b");

    expect(await getContent(page)).toBe("abc\ndef");
  });

  test("矢印キーは置換せず選択をキャレットへ畳むだけ", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef" });

    await selectMarkdownRange(page, 0, 0, 1, "def".length);
    await page.keyboard.press("ArrowRight");

    expect(await getContent(page)).toBe("abc\ndef");
  });

  test("Escape は置換せず選択を解除するだけ", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef" });

    await selectMarkdownRange(page, 0, 0, 1, "def".length);
    await page.keyboard.press("Escape");

    expect(await getContent(page)).toBe("abc\ndef");
    expect(await page.evaluate(() => window.getSelection()!.rangeCount)).toBe(0);
  });
});

test.describe("IME での置換は非対応（何も起きない・選択が壊れない）", () => {
  test("composition 中相当の keydown（isComposing・keyCode 229）は内容も選択も変えない", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef" });

    await selectMarkdownRange(page, 0, 0, 1, "def".length);
    await page.evaluate(() => {
      const ev = new KeyboardEvent("keydown", { key: "Process", bubbles: true, cancelable: true, isComposing: true });
      Object.defineProperty(ev, "keyCode", { get: () => 229 });
      document.dispatchEvent(ev);
    });

    expect(await getContent(page)).toBe("abc\ndef");
    expect(await page.evaluate(() => window.getSelection()!.toString())).toBe("abc\ndef");
  });

  test("mdView 内に選択を張ると、ブラウザが mdView へフォーカスを移す（contenteditable の既定動作）", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef" });

    await selectMarkdownRange(page, 0, 0, 1, "def".length);

    const isEditable = await page.evaluate(() => (document.activeElement as HTMLElement)?.isContentEditable ?? false);
    expect(isEditable).toBe(true);
  });
});
