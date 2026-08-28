import { test, expect, injectNoteMock, enterEdit, placeCaret, getContent } from "./fixtures";

// 画像のみの行（前後空白のみの `![alt|width](images/...)`）は、クリック・↑↓ の
// どちらからも生表示に入らず、代わりに「選択状態」になる。削除は選択中の
// Backspace / Delete で行う（image-delete-e2e.spec.ts）。

const IMAGE_PATH = "images/00000000-0000-4000-8000-000000000001.png";
const IMAGE_LINE = `![](${IMAGE_PATH})`;

test.describe("画像の選択状態", () => {
  test("画像本体のクリックで選択状態になる", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `text0\n${IMAGE_LINE}` });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      const img = document.querySelector("img")!;
      img.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    });

    await expect(page.locator(".img-selected")).toHaveCount(1);
    await expect(page.locator("#editor")).toHaveCount(0);

    await ctx.close();
  });

  test("画像のみの行の余白クリック（img 以外の同じ行）でも選択状態になる", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `${IMAGE_LINE}\ntext1` });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    // asset:// URL はテスト環境で解決できず <img> はレイアウトサイズ 0 になるため、
    // ブロック div（[data-line="0"]）をクリックしても img には当たらない
    await page.locator('[data-line="0"]').click({ force: true });

    await expect(page.locator(".img-selected")).toHaveCount(1);
    await expect(page.locator("#editor")).toHaveCount(0);

    await ctx.close();
  });

  test("画像のみの行が最終行 → 余白クリック（付箋の空白部分）でも選択状態になる", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `text0\n${IMAGE_LINE}` });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    // 余白クリック（画像のみの行が最終行）は選択状態になり #editor は開かないので、
    // #editor の出現を待つ enterEdit は使わず直接クリックする
    await page.click("#markdown-view");

    await expect(page.locator(".img-selected")).toHaveCount(1);
    await expect(page.locator("#editor")).toHaveCount(0);

    await ctx.close();
  });

  test("付箋全体が画像のみの行 1 本 → 選択して削除すれば通常どおり入力できる（行き詰まりの回帰防止）", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: IMAGE_LINE }, {}, { captureInvokes: true });
    await page.addInitScript(() => {
      const prevInvoke = (window as any).__TAURI__.core.invoke;
      (window as any).__TAURI__.core.invoke = async (cmd: string, args?: unknown) => {
        if (cmd === "delete_image") return "";
        return prevInvoke(cmd, args);
      };
    });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.click("#markdown-view"); // 画像のみの行 1 本 → 選択状態（#editor は開かない）
    await expect(page.locator(".img-selected")).toHaveCount(1);

    await page.keyboard.press("Delete");
    await expect.poll(() => getContent(page)).toBe("");

    // 画像が消えた後は通常どおりクリックで入力できる
    await enterEdit(page);
    await expect(page.locator("#editor")).toBeVisible();
    await page.locator("#editor").pressSequentially("hello");
    expect(await getContent(page)).toBe("hello");

    await ctx.close();
  });

  test("↓ でテキスト行 → 画像のみの行（選択）→ テキスト行と遷移する", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `text0\n${IMAGE_LINE}\ntext2` });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await placeCaret(page, 0, 0);
    await page.locator("#editor").press("ArrowDown");

    await expect(page.locator("#editor")).toHaveCount(0);
    await expect(page.locator(".img-selected")).toHaveCount(1);

    await page.keyboard.press("ArrowDown");

    await expect(page.locator(".img-selected")).toHaveCount(0);
    await expect(page.locator("#editor")).toBeVisible();
    expect(await page.locator("#editor").textContent()).toBe("text2");

    await ctx.close();
  });

  test("↑ で連続する画像のみの行を経ても、1 行ずつ選択状態が続く（飛び越えない）", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `text0\n${IMAGE_LINE}\n${IMAGE_LINE}\ntext3` });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await placeCaret(page, 3, 0);
    await page.locator("#editor").press("ArrowUp"); // text3 → line2（画像のみ、選択）

    await expect(page.locator(".img-selected")).toHaveCount(1);
    await expect(page.locator("#editor")).toHaveCount(0);

    await page.keyboard.press("ArrowUp"); // line2 → line1（画像のみ、選択のまま）

    await expect(page.locator(".img-selected")).toHaveCount(1);
    await expect(page.locator("#editor")).toHaveCount(0);

    await page.keyboard.press("ArrowUp"); // line1 → line0（text0、生表示）

    await expect(page.locator(".img-selected")).toHaveCount(0);
    await expect(page.locator("#editor")).toBeVisible();
    expect(await page.locator("#editor").textContent()).toBe("text0");

    await ctx.close();
  });

  test("↓ の先が無ければ選択を維持する（端）", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `text0\n${IMAGE_LINE}` });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await placeCaret(page, 0, 0);
    await page.locator("#editor").press("ArrowDown");
    await expect(page.locator(".img-selected")).toHaveCount(1);

    await page.keyboard.press("ArrowDown");

    await expect(page.locator(".img-selected")).toHaveCount(1); // 変わらない
    await expect(page.locator("#editor")).toHaveCount(0);

    await ctx.close();
  });

  test("↑ の先が無ければ選択を維持する（端）", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `${IMAGE_LINE}\ntext1` });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await placeCaret(page, 1, 0);
    await page.locator("#editor").press("ArrowUp");
    await expect(page.locator(".img-selected")).toHaveCount(1);

    await page.keyboard.press("ArrowUp");

    await expect(page.locator(".img-selected")).toHaveCount(1);
    await expect(page.locator("#editor")).toHaveCount(0);

    await ctx.close();
  });

  test("行末で → の先が画像のみの行なら選択状態になる", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `text0\n${IMAGE_LINE}\ntext2` });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await placeCaret(page, 0, null);
    await page.locator("#editor").press("ArrowRight");

    await expect(page.locator(".img-selected")).toHaveCount(1);
    await expect(page.locator("#editor")).toHaveCount(0);

    await ctx.close();
  });

  test("行頭で ← の先が画像のみの行なら選択状態になる", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `text0\n${IMAGE_LINE}\ntext2` });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await placeCaret(page, 2, 0);
    await page.locator("#editor").press("ArrowLeft");

    await expect(page.locator(".img-selected")).toHaveCount(1);
    await expect(page.locator("#editor")).toHaveCount(0);

    await ctx.close();
  });

  test("画像選択状態から ← / → で隣の行へ抜けられる", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `text0\n${IMAGE_LINE}\ntext2` });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await placeCaret(page, 0, null);
    await page.locator("#editor").press("ArrowRight"); // text0 → 画像行（選択状態）
    await expect(page.locator(".img-selected")).toHaveCount(1);

    await page.keyboard.press("ArrowRight"); // 画像行 → text2（↑/↓ ではなく → で抜ける）

    await expect(page.locator(".img-selected")).toHaveCount(0);
    await expect(page.locator("#editor")).toBeVisible();
    expect(await page.locator("#editor").textContent()).toBe("text2");

    await page.keyboard.press("ArrowLeft"); // text2 → 画像行（選択状態）
    await expect(page.locator(".img-selected")).toHaveCount(1);
    await expect(page.locator("#editor")).toHaveCount(0);

    await page.keyboard.press("ArrowLeft"); // 画像行 → text0（← で抜ける）

    await expect(page.locator(".img-selected")).toHaveCount(0);
    await expect(page.locator("#editor")).toBeVisible();
    expect(await page.locator("#editor").textContent()).toBe("text0");

    await ctx.close();
  });

  test("選択中に Enter → 画像の直下に空行を挿入し、そこへキャレット（選択は解除）", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `text0\n${IMAGE_LINE}\ntext2` });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.locator('[data-line="1"]').click({ force: true });
    await expect(page.locator(".img-selected")).toHaveCount(1);

    await page.keyboard.press("Enter");

    await expect(page.locator(".img-selected")).toHaveCount(0);
    await expect(page.locator("#editor")).toBeVisible();
    expect(await page.locator("#editor").textContent()).toBe("");
    expect(await getContent(page)).toBe(`text0\n${IMAGE_LINE}\n\ntext2`);

    await ctx.close();
  });

  test("選択中に Shift+Enter → 画像の直上に空行を挿入し、そこへキャレット（画像が先頭行でも）", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `${IMAGE_LINE}\ntext1` });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.locator('[data-line="0"]').click({ force: true });
    await expect(page.locator(".img-selected")).toHaveCount(1);

    await page.keyboard.press("Shift+Enter");

    await expect(page.locator(".img-selected")).toHaveCount(0);
    await expect(page.locator("#editor")).toBeVisible();
    expect(await page.locator("#editor").textContent()).toBe("");
    expect(await getContent(page)).toBe(`\n${IMAGE_LINE}\ntext1`);

    await ctx.close();
  });

  test("Esc で選択解除", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `text0\n${IMAGE_LINE}` });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.click("#markdown-view");
    await expect(page.locator(".img-selected")).toHaveCount(1);

    await page.keyboard.press("Escape");

    await expect(page.locator(".img-selected")).toHaveCount(0);
    await expect(page.locator("#editor")).toHaveCount(0);

    await ctx.close();
  });

  test("別の行をクリックすると選択解除される", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `text0\n${IMAGE_LINE}` });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.click("#markdown-view");
    await expect(page.locator(".img-selected")).toHaveCount(1);

    await page.locator('[data-line="0"]').click();

    await expect(page.locator(".img-selected")).toHaveCount(0);
    await expect(page.locator("#editor")).toBeVisible();
    expect(await page.locator("#editor").textContent()).toBe("text0");

    await ctx.close();
  });

  test("ダブルクリックは選択と共存する（open_image が呼ばれる）", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: IMAGE_LINE }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      const img = document.querySelector("img")!;
      img.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });

    await expect.poll(() =>
      page.evaluate(() =>
        (window as any).__captured_invokes.filter((c: any) => c.cmd === "open_image").length,
      ),
    ).toBe(1);

    await ctx.close();
  });

  test("右クリックメニューは選択と共存する（show_context_menu に imagePath が渡る）", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: IMAGE_LINE }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      const img = document.querySelector("img")!;
      img.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      img.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });

    await expect.poll(() =>
      page.evaluate(() =>
        (window as any).__captured_invokes.filter((c: any) => c.cmd === "show_context_menu").length,
      ),
    ).toBe(1);
    const calls = await page.evaluate(() =>
      (window as any).__captured_invokes.filter((c: any) => c.cmd === "show_context_menu"),
    );
    expect(calls[0].args.imagePath).toBe(IMAGE_PATH);
    // line/occurrence は渡さない
    expect(calls[0].args.imageLine).toBeUndefined();
    expect(calls[0].args.imageOccurrence).toBeUndefined();

    await ctx.close();
  });

  test("リサイズハンドルへの mousedown は選択を消さない", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `![|100](${IMAGE_PATH})` }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      const img = document.querySelector("img")!;
      img.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true }));
      img.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    });
    await expect(page.locator(".img-selected")).toHaveCount(1);

    await page.evaluate(() => {
      const handle = document.querySelector(".img-resize-handle")!;
      handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });

    await expect(page.locator(".img-selected")).toHaveCount(1);

    await ctx.close();
  });

  test("リサイズのドラッグ確定（renderAll 経由）後も選択が正しく復元される", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 600, height: 400 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: IMAGE_LINE }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      const img = document.querySelector("img")!;
      img.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    });
    await expect(page.locator(".img-selected")).toHaveCount(1);

    // ドラッグでリサイズ確定 → applyImageWidth が renderAll() を呼び、mdView.innerHTML が
    // 丸ごと差し替わる（.img-selected が付いていた古い img 要素ごと消える）
    await page.evaluate(([startX, endX]) => {
      const img = document.querySelector("img")!;
      const handle = document.querySelector(".img-resize-handle")!;
      img.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: startX, clientY: 0 }));
      handle.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, clientX: startX, clientY: 0, buttons: 1 }),
      );
      document.dispatchEvent(
        new MouseEvent("mousemove", { bubbles: true, clientX: endX, clientY: 0, buttons: 1 }),
      );
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: endX, clientY: 0 }));
    }, [0, 50]);

    expect(await getContent(page)).toBe(`![|250](${IMAGE_PATH})`);
    // renderAll 後も選択枠は同じ画像に付き直っている
    await expect(page.locator(".img-selected")).toHaveCount(1);
    const stillSelected = await page.evaluate(() => document.querySelector("img.img-selected") != null);
    expect(stillSelected).toBe(true);

    await ctx.close();
  });

  test("未終端フェンスの最終行が画像のみの行に見えても選択にならず、生表示に入る（退行防止）", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    // 閉じフェンスが無いため、フェンス開始行〜最終行がまとめて 1 つの <pre> ブロックになる
    const content = "```\ntext\n" + IMAGE_LINE;
    await injectNoteMock(page, { content });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await enterEdit(page); // 余白クリック → 最終行（フェンス内、見た目は画像のみ）

    await expect(page.locator("#editor")).toBeVisible();
    expect(await page.locator("#editor").textContent()).toBe(content);
    await expect(page.locator(".img-selected")).toHaveCount(0);

    await ctx.close();
  });

  test("テキストと画像が混在する行は従来どおり生表示に入る（選択にならない・退行防止）", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `text ${IMAGE_LINE}` });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await enterEdit(page);

    await expect(page.locator("#editor")).toBeVisible();
    expect(await page.locator("#editor").textContent()).toBe(`text ${IMAGE_LINE}`);
    await expect(page.locator(".img-selected")).toHaveCount(0);

    await ctx.close();
  });
});
