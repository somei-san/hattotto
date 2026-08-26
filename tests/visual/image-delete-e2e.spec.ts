import { test, expect, injectNoteMock, getContent } from "./fixtures";

// 選択中の画像は Backspace / Delete で削除する。ここではフロントエンドが選択状態からの
// キー操作をどう `delete_image` invoke に翻訳し、戻り値をどう反映するかを検証する。

const IMAGE_PATH = "images/00000000-0000-4000-8000-000000000001.png";
const IMAGE_LINE = `![](${IMAGE_PATH})`;

/** 生表示を経由せず、選択状態にするための直接呼び出し（画像のみの行なら enterLine が選択する）。 */
function selectImageAtLine(page: import("@playwright/test").Page, line: number) {
  return page.evaluate(
    (l) => (window as unknown as { enterLine(l: number, c: number | null): void }).enterLine(l, null),
    line,
  );
}

/**
 * `delete_image` の戻り値（または例外）を固定する。それ以外のコマンドは通常どおり処理する。
 * delayMs を指定すると解決を遅らせる（in-flight 中の多重発火ガードを検証するため）。
 */
function mockDeleteImage(
  page: import("@playwright/test").Page,
  result: string | null,
  shouldThrow = false,
  delayMs = 0,
) {
  return page.addInitScript(([r, throwIt, delay]) => {
    const prevInvoke = (window as any).__TAURI__.core.invoke;
    (window as any).__TAURI__.core.invoke = async (cmd: string, args?: unknown) => {
      if (cmd === "delete_image") {
        // captureInvokes の記録はここで肩代わりする（下の分岐は通らないため素通りしない）
        (window as any).__captured_invokes?.push({ cmd, args });
        if (delay) await new Promise((res) => setTimeout(res, delay as number));
        if (throwIt) throw new Error("delete_image failed");
        return r;
      }
      return prevInvoke(cmd, args);
    };
  }, [result, shouldThrow, delayMs] as const);
}

async function lastDeleteImageCall(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const calls = (window as any).__captured_invokes.filter((c: any) => c.cmd === "delete_image");
    return calls[calls.length - 1]?.args;
  });
}

// テスト用の webServer（serve の clean-urls）が `/note.html?id=...` を `/note` へ 301 する際に
// クエリ文字列を落とすため、この環境では note.js 側の noteId が常に null になる
// （id を見ないモックの get_note 等では表面化しないが、id をそのまま invoke に渡す
// delete_image では顕在化する）。id 以外のフィールドで検証する
function expectDeleteImageArgs(
  args: unknown,
  expected: { imagePath: string; imageLine: number; imageOccurrence: number },
) {
  expect(args).toMatchObject(expected);
}

test.describe("選択中の画像を Backspace / Delete で削除する", () => {
  test("Backspace → delete_image が正しい引数で invoke され、キャレットは前の行へ", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `text0\n${IMAGE_LINE}\ntext2` }, {}, { captureInvokes: true });
    await mockDeleteImage(page, "text0\ntext2");
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await selectImageAtLine(page, 1);
    await expect(page.locator(".img-selected")).toHaveCount(1);

    await page.keyboard.press("Backspace");

    await expect.poll(() => lastDeleteImageCall(page)).toBeTruthy();
    const args = await lastDeleteImageCall(page);
    expectDeleteImageArgs(args, { imagePath: IMAGE_PATH, imageLine: 1, imageOccurrence: 0 });

    await expect.poll(() => getContent(page)).toBe("text0\ntext2");
    await expect(page.locator(".img-selected")).toHaveCount(0);
    await expect(page.locator("#editor")).toBeVisible();
    expect(await page.locator("#editor").textContent()).toBe("text0");

    await ctx.close();
  });

  test("Delete → キャレットは（繰り上がった）同じ index の行へ", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `text0\n${IMAGE_LINE}\ntext2` }, {}, { captureInvokes: true });
    await mockDeleteImage(page, "text0\ntext2");
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await selectImageAtLine(page, 1);
    await page.keyboard.press("Delete");

    const args = await lastDeleteImageCall(page);
    expectDeleteImageArgs(args, { imagePath: IMAGE_PATH, imageLine: 1, imageOccurrence: 0 });

    // 削除後、旧 line2（"text2"）が index 1 に繰り上がる。Delete はその index を優先する
    await expect(page.locator("#editor")).toBeVisible();
    expect(await page.locator("#editor").textContent()).toBe("text2");

    await ctx.close();
  });

  test("Backspace で先頭行を削除 → 前の行が無いので先頭に留まる（末尾へは飛ばない）", async ({ browser }) => {
    // 3 行以上のフィクスチャでないと「先頭に留まる」と「末尾へ飛ぶ」の区別がつかない
    // （2 行だと削除後は 1 行しか残らず、どちらの解釈でも同じ行に着地してしまう）
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `${IMAGE_LINE}\ntext1\ntext2` }, {}, { captureInvokes: true });
    await mockDeleteImage(page, "text1\ntext2");
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await selectImageAtLine(page, 0);
    await page.keyboard.press("Backspace");

    await expect(page.locator("#editor")).toBeVisible();
    expect(await page.locator("#editor").textContent()).toBe("text1");

    await ctx.close();
  });

  test("delete_image が null（キャンセル）を返すと選択を維持したまま何も変わらない", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    const content = `text0\n${IMAGE_LINE}`;
    await injectNoteMock(page, { content }, {}, { captureInvokes: true });
    await mockDeleteImage(page, null);
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await selectImageAtLine(page, 1);
    await page.keyboard.press("Delete");

    await expect.poll(() => lastDeleteImageCall(page)).toBeTruthy();
    // content は変わらず、選択も解除されない（生表示にも入らない）
    expect(await getContent(page)).toBe(content);
    await expect(page.locator(".img-selected")).toHaveCount(1);
    await expect(page.locator("#editor")).toHaveCount(0);

    await ctx.close();
  });

  test("delete_image が失敗（reject）するとトーストが出て選択は維持される", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    const content = `text0\n${IMAGE_LINE}`;
    await injectNoteMock(page, { content }, {}, { captureInvokes: true });
    await mockDeleteImage(page, null, true);
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await selectImageAtLine(page, 1);
    await page.keyboard.press("Backspace");

    await expect(page.locator(".toast")).toBeVisible();
    expect(await getContent(page)).toBe(content);
    await expect(page.locator(".img-selected")).toHaveCount(1);

    await ctx.close();
  });

  test("混在行の画像も選択して削除できる（occurrence 指定はそのまま）", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `text ${IMAGE_LINE} 続き` }, {}, { captureInvokes: true });
    await mockDeleteImage(page, "text  続き");
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    // 混在行は画像本体クリックで選択する（生表示中の行ではない）
    await page.evaluate(() => {
      const img = document.querySelector("img")!;
      img.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    });
    await expect(page.locator(".img-selected")).toHaveCount(1);

    await page.keyboard.press("Delete");

    const args = await lastDeleteImageCall(page);
    expectDeleteImageArgs(args, { imagePath: IMAGE_PATH, imageLine: 0, imageOccurrence: 0 });
    await expect.poll(() => getContent(page)).toBe("text  続き");

    await ctx.close();
  });

  // code-reviewer 指摘の回帰: imageOccurrenceInLine（DOM・relSrc 単位）で選んだ画像を、
  // 行テキストの通し番号で src を引き直す旧実装だと別の画像を対象にしてしまっていた
  const IMAGE_PATH_2 = "images/00000000-0000-4000-8000-000000000002.png";
  test("同じ行に別々の画像2枚 → 2枚目を選択・削除すると正しい方（2枚目）が対象になる", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(
      page,
      { content: `![](${IMAGE_PATH}) ![](${IMAGE_PATH_2})` },
      {},
      { captureInvokes: true },
    );
    await mockDeleteImage(page, `![](${IMAGE_PATH}) `);
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      document.querySelectorAll("img")[1].dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true, cancelable: true }),
      );
    });
    await expect(page.locator(".img-selected")).toHaveCount(1);
    const selectedIsSecond = await page.evaluate(
      () => document.querySelectorAll("img")[1].classList.contains("img-selected"),
    );
    expect(selectedIsSecond).toBe(true);

    await page.keyboard.press("Delete");

    const args = await lastDeleteImageCall(page);
    expectDeleteImageArgs(args, { imagePath: IMAGE_PATH_2, imageLine: 0, imageOccurrence: 0 });
    await expect.poll(() => getContent(page)).toBe(`![](${IMAGE_PATH}) `);

    await ctx.close();
  });

  test("Backspace 連打（in-flight 中）でも delete_image は 1 回しか呼ばれない", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `text0\n${IMAGE_LINE}` }, {}, { captureInvokes: true });
    await mockDeleteImage(page, "text0", false, 200);
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await selectImageAtLine(page, 1);
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace"); // in-flight 中の連打（キーリピート相当）
    await page.keyboard.press("Backspace");

    await page.waitForTimeout(400); // 200ms の遅延 + マージン

    const calls = await page.evaluate(() =>
      (window as any).__captured_invokes.filter((c: any) => c.cmd === "delete_image"),
    );
    expect(calls.length).toBe(1);

    await ctx.close();
  });

  test("削除前に別行の未保存入力を flush する（デバウンス窓での消失防止）", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: `line0\n${IMAGE_LINE}` }, {}, { captureInvokes: true });
    await mockDeleteImage(page, "line0X");
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.locator('[data-line="0"]').click();
    await page.waitForSelector("#editor", { state: "visible" });
    await page.locator("#editor").click();
    await page.keyboard.type("X"); // scheduleSave() の 300ms デバウンスが保留中になる

    // 画像行を選択状態にする（生表示は commit されるが、保存はまだ飛んでいない）
    await selectImageAtLine(page, 1);
    await expect(page.locator(".img-selected")).toHaveCount(1);

    await page.keyboard.press("Backspace");

    await expect.poll(() => lastDeleteImageCall(page)).toBeTruthy();

    const calls = await page.evaluate(() => (window as any).__captured_invokes);
    const updateIdx = calls.findIndex(
      (c: any) => c.cmd === "update_note_content" && c.args.content === `line0X\n${IMAGE_LINE}`,
    );
    const deleteIdx = calls.findIndex((c: any) => c.cmd === "delete_image");
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeLessThan(deleteIdx);

    await ctx.close();
  });
});
