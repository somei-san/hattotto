import { test, expect, injectNoteMock, enterEdit, getContent, placeCaret, commitHistory } from "./fixtures";

// ⌘Z/⌘⇧Z はネイティブメニュー（src-tauri/src/menu.rs）が拾い edit-history イベントで
// フロントへ通知するため、chromium からはキーボードショートカットを再現できない。
// ここでは note.js が公開する window.performUndo/performRedo を直接呼び、
// history.js との結線（保存確定のたびに履歴へ積む・巻き戻し後の再描画・キャレット位置）を検証する。

const IMAGE_PATH = "images/00000000-0000-4000-8000-000000000001.png";
const IMAGE_LINE = `![](${IMAGE_PATH})`;

const IMAGE_PATH_A = "images/00000000-0000-4000-8000-0000000000aa.png";
const IMAGE_PATH_B = "images/00000000-0000-4000-8000-0000000000bb.png";
const IMAGE_LINE_A = `![](${IMAGE_PATH_A})`;
const IMAGE_LINE_B = `![](${IMAGE_PATH_B})`;

function performUndo(page: import("@playwright/test").Page) {
  return page.evaluate(() => (window as any).performUndo());
}

function performRedo(page: import("@playwright/test").Page) {
  return page.evaluate(() => (window as any).performRedo());
}

async function openCaptured(overrides: Record<string, unknown>, browser: import("@playwright/test").Browser) {
  const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
  const page = await ctx.newPage();
  await injectNoteMock(page, overrides, {}, { captureInvokes: true });
  await page.goto("/note.html?id=test-note-id");
  await page.waitForLoadState("networkidle");
  return { ctx, page };
}

function savedContents(page: import("@playwright/test").Page) {
  return page.evaluate(() =>
    (window as any).__captured_invokes
      .filter((c: any) => c.cmd === "update_note_content")
      .map((c: any) => c.args.content),
  );
}

test.describe("Undo/Redo", () => {
  test("入力を保存確定 → performUndo で戻り、performRedo で復帰する", async ({ browser }) => {
    const { ctx, page } = await openCaptured({ content: "" }, browser);

    await enterEdit(page);
    await page.locator("#markdown-view").pressSequentially("abc");
    // 保存を確定させ、history.commit("abc") を積ませる
    await expect.poll(() => getContent(page)).toBe("abc");
    await commitHistory(page);

    await performUndo(page);
    await expect.poll(() => getContent(page)).toBe("");

    await performRedo(page);
    await expect.poll(() => getContent(page)).toBe("abc");

    await ctx.close();
  });

  test("undo 後に復元した content で update_note_content が invoke される", async ({ browser }) => {
    const { ctx, page } = await openCaptured({ content: "" }, browser);

    await enterEdit(page);
    await page.locator("#markdown-view").pressSequentially("abc");
    await commitHistory(page);

    await performUndo(page);
    await expect.poll(() => savedContents(page)).toContain("");
    const contents = await savedContents(page);
    expect(contents[contents.length - 1]).toBe("");

    await ctx.close();
  });

  test("undo 後のキャレットが差分行に置かれる（2行目を編集 → undo で1行目に残らない）", async ({ browser }) => {
    const { ctx, page } = await openCaptured({ content: "line0\nline1" }, browser);

    await placeCaret(page, 1);
    await page.locator("#markdown-view").pressSequentially("X");
    await commitHistory(page);
    await expect.poll(() => getContent(page)).toBe("line0\nline1X");

    await performUndo(page);
    await expect.poll(() => getContent(page)).toBe("line0\nline1");
    // 差分は 2 行目（index 1）なので、そこにキャレットが置かれているはず
    const line = await page.evaluate(() => {
      const node = window.getSelection()?.anchorNode ?? null;
      return (node instanceof Element ? node : node?.parentElement)?.closest("[data-line]")?.getAttribute("data-line");
    });
    expect(line).toBe("1");

    await ctx.close();
  });

  test("複数回の編集を複数回の performUndo で段階的に戻る", async ({ browser }) => {
    const { ctx, page } = await openCaptured({ content: "" }, browser);

    await enterEdit(page);
    await page.locator("#markdown-view").pressSequentially("a");
    await commitHistory(page);
    await expect.poll(() => getContent(page)).toBe("a");

    await page.locator("#markdown-view").pressSequentially("b");
    await commitHistory(page);
    await expect.poll(() => getContent(page)).toBe("ab");

    await performUndo(page);
    await expect.poll(() => getContent(page)).toBe("a");

    await performUndo(page);
    await expect.poll(() => getContent(page)).toBe("");

    await ctx.close();
  });

  test("undo 後に新しい編集をすると redo スタックがクリアされる", async ({ browser }) => {
    const { ctx, page } = await openCaptured({ content: "" }, browser);

    await enterEdit(page);
    await page.locator("#markdown-view").pressSequentially("abc");
    await commitHistory(page);
    await expect.poll(() => getContent(page)).toBe("abc");

    await performUndo(page);
    await expect.poll(() => getContent(page)).toBe("");

    await enterEdit(page);
    await page.locator("#markdown-view").pressSequentially("xyz");
    await commitHistory(page);
    await expect.poll(() => getContent(page)).toBe("xyz");

    // "abc" へ戻る redo は消えているはずなので、performRedo は no-op
    await performRedo(page);
    await expect.poll(() => getContent(page)).toBe("xyz");

    await ctx.close();
  });

  test("画像行の削除を performUndo で取り消すと画像記法が content に戻る", async ({ browser }) => {
    const content = `text0\n${IMAGE_LINE}\ntext2`;
    const { ctx, page } = await openCaptured({ content }, browser);
    await page.addInitScript(([resolved]) => {
      const prevInvoke = (window as any).__TAURI__.core.invoke;
      (window as any).__TAURI__.core.invoke = async (cmd: string, args?: unknown) => {
        if (cmd === "delete_image") {
          (window as any).__captured_invokes?.push({ cmd, args });
          return resolved;
        }
        return prevInvoke(cmd, args);
      };
    }, ["text0\ntext2"]);
    await page.reload();
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => (window as any).placeCaretAtRaw(1, null));
    await expect(page.locator(".img-selected")).toHaveCount(1);
    await page.keyboard.press("Backspace");
    await expect.poll(() => getContent(page)).toBe("text0\ntext2");

    await performUndo(page);
    await expect.poll(() => getContent(page)).toBe(content);

    await ctx.close();
  });

  // 「編集を確定 → undo → 別の変更（画像削除等）→ redo」で、別の変更を経由せず
  // undo 前の状態へ巻き戻らないことを検証する（画像削除で redoStack がクリアされるため）。
  test("undo 後に画像削除を行うと、その後の performRedo は削除前の状態へ巻き戻らない", async ({ browser }) => {
    const before = `text0\n${IMAGE_LINE_A}\n${IMAGE_LINE_B}`;
    const { ctx, page } = await openCaptured({ content: before }, browser);
    await page.addInitScript(([resolved]) => {
      const prevInvoke = (window as any).__TAURI__.core.invoke;
      (window as any).__TAURI__.core.invoke = async (cmd: string, args?: unknown) => {
        if (cmd === "delete_image") {
          (window as any).__captured_invokes?.push({ cmd, args });
          return resolved;
        }
        return prevInvoke(cmd, args);
      };
    }, [`text0\n${IMAGE_LINE_A}`]);
    await page.reload();
    await page.waitForLoadState("networkidle");

    // 1手目: text0 行を編集して確定する
    await page.locator('[data-line="0"]').click();
    await page.locator("#markdown-view").pressSequentially("X");
    await commitHistory(page);
    const edited = `text0X\n${IMAGE_LINE_A}\n${IMAGE_LINE_B}`;
    await expect.poll(() => getContent(page)).toBe(edited);

    // undo で編集前（画像 2 枚がある状態）に戻す
    await performUndo(page);
    await expect.poll(() => getContent(page)).toBe(before);

    // 2 枚目（2 行目）の画像を削除する
    await page.evaluate(() => (window as any).placeCaretAtRaw(2, null));
    await expect(page.locator(".img-selected")).toHaveCount(1);
    await page.keyboard.press("Backspace");
    const afterDelete = `text0\n${IMAGE_LINE_A}`;
    await expect.poll(() => getContent(page)).toBe(afterDelete);

    // redo は「編集を確定した後の状態（画像 2 枚とも残る）」へ巻き戻ってはいけない。
    // 削除で redoStack はクリアされているので no-op（削除後の状態を維持する）
    await performRedo(page);
    await expect.poll(() => getContent(page)).toBe(afterDelete);
    expect(await getContent(page)).not.toBe(edited);

    await ctx.close();
  });

  test("edit-history イベントの undo/redo/未知の payload を正しく分岐する", async ({ browser }) => {
    const { ctx, page } = await openCaptured({ content: "" }, browser);

    await enterEdit(page);
    await page.locator("#markdown-view").pressSequentially("abc");
    await commitHistory(page);
    await expect.poll(() => getContent(page)).toBe("abc");

    // appWindow.listen ではなく listen('edit-history', ...) 側（グローバルイベント）に
    // 登録されたハンドラを直接呼ぶ。この環境では document.hasFocus() が true になるため、
    // ハンドラ内の hasFocus() ゲートも実際に通ったうえで undo/redo の分岐を検証している
    // （hasFocus() が false になる経路はここではカバーしていない）
    await page.evaluate(() => {
      const listeners = (window as any).__globalListeners["edit-history"];
      listeners?.forEach((fn: any) => fn({ payload: "undo" }));
    });
    await expect.poll(() => getContent(page)).toBe("");

    await page.evaluate(() => {
      const listeners = (window as any).__globalListeners["edit-history"];
      listeners?.forEach((fn: any) => fn({ payload: "redo" }));
    });
    await expect.poll(() => getContent(page)).toBe("abc");

    // 未知の payload は undo にも redo にも解釈されず、何も変わらない
    await page.evaluate(() => {
      const listeners = (window as any).__globalListeners["edit-history"];
      listeners?.forEach((fn: any) => fn({ payload: "unknown" }));
    });
    await expect.poll(() => getContent(page)).toBe("abc");

    await ctx.close();
  });

  test("beforeinput の historyUndo/historyRedo は preventDefault される", async ({ notePage: page }) => {
    const prevented = await page.evaluate(() => {
      const results: boolean[] = [];
      for (const inputType of ["historyUndo", "historyRedo"]) {
        const e = new InputEvent("beforeinput", { inputType, cancelable: true, bubbles: true });
        document.dispatchEvent(e);
        results.push(e.defaultPrevented);
      }
      return results;
    });
    expect(prevented).toEqual([true, true]);
  });

  test("履歴が無い状態の performUndo は no-op", async ({ notePage: page }) => {
    const before = await getContent(page);
    await performUndo(page);
    await expect.poll(() => getContent(page)).toBe(before);
  });
});
