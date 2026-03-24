import { test as base, expect, type Page } from "@playwright/test";

// trash.html 用の拡張モック（invokeキャプチャ + dialog.confirm モック付き）
async function injectTrashMockWithCapture(
  page: Page,
  trashItems: Record<string, unknown>[],
  options: { confirmResult?: boolean } = {},
) {
  await page.addInitScript((data) => {
    const calls: { cmd: string; args: unknown }[] = [];
    (window as any).__captured_invokes = calls;
    let items = [...data.items];

    (window as any).__TAURI__ = {
      core: {
        invoke: async (cmd: string, args?: any) => {
          calls.push({ cmd, args });
          switch (cmd) {
            case "get_trash":     return items;
            case "get_trash_max": return 200;
            case "restore_note": {
              items = items.filter((n: any) => n.id !== args?.id);
              return null;
            }
            case "empty_trash": {
              items = [];
              return null;
            }
            default: return null;
          }
        },
      },
      dialog: {
        confirm: async () => data.confirmResult,
      },
      webviewWindow: {
        getCurrentWebviewWindow: () => ({
          close: async () => {},
        }),
      },
    };
  }, { items: trashItems, confirmResult: options.confirmResult ?? true });
}

const test = base.extend<{
  openTrashE2E: (items: Record<string, unknown>[], options?: { confirmResult?: boolean }) => Promise<Page>;
}>({
  openTrashE2E: async ({ browser }, use) => {
    const pages: Page[] = [];
    const open = async (items: Record<string, unknown>[] = [], options: { confirmResult?: boolean } = {}) => {
      const ctx = await browser.newContext({ viewport: { width: 360, height: 480 } });
      const page = await ctx.newPage();
      await injectTrashMockWithCapture(page, items, options);
      await page.goto("/trash.html");
      await page.waitForLoadState("networkidle");
      pages.push(page);
      return page;
    };
    await use(open);
    for (const p of pages) await p.context().close();
  },
});

const SAMPLE_NOTES = [
  { id: "n1", content: "First note", color: "yellow", x: 0, y: 0, width: 280, height: 320, zoom: 100, deleted_at: 1700000000 },
  { id: "n2", content: "Second note", color: "blue", x: 0, y: 0, width: 280, height: 320, zoom: 100, deleted_at: 1700001000 },
];

test.describe("ゴミ箱の復元フロー", () => {
  test("復元ボタンクリック → restore_note invoke → リストからアイテムが消える", async ({ openTrashE2E }) => {
    const page = await openTrashE2E(SAMPLE_NOTES);

    // 初期状態: 2件表示
    await expect(page.locator(".item")).toHaveCount(2);
    await expect(page.locator("#trash-count")).toHaveText("(2 / 200)");

    // 最初の復元ボタンをクリック（逆順表示なのでn2が先頭）
    await page.locator(".btn-restore").first().click();

    // リストが再描画されて1件になる
    await expect(page.locator(".item")).toHaveCount(1);
    await expect(page.locator("#trash-count")).toHaveText("(1 / 200)");

    // restore_note invoke が呼ばれたことを確認
    const calls = await page.evaluate(() =>
      (window as any).__captured_invokes.filter((c: any) => c.cmd === "restore_note")
    );
    expect(calls).toHaveLength(1);
    expect((calls[0] as any).args.id).toBe("n2");
  });

  test("全件復元 → ゴミ箱が空になる", async ({ openTrashE2E }) => {
    const page = await openTrashE2E(SAMPLE_NOTES);
    await expect(page.locator(".item")).toHaveCount(2);

    // 1件目を復元
    await page.locator(".btn-restore").first().click();
    await expect(page.locator(".item")).toHaveCount(1);

    // 2件目を復元
    await page.locator(".btn-restore").first().click();
    await expect(page.locator(".item")).toHaveCount(0);
    await expect(page.locator(".empty-msg")).toHaveText("ゴミ箱は空です");
    await expect(page.locator("#trash-count")).toHaveText("(0 / 200)");
  });
});

test.describe("ゴミ箱の全削除フロー", () => {
  test("「すべて削除」→ confirm OK → empty_trash invoke → 空になる", async ({ openTrashE2E }) => {
    const page = await openTrashE2E(SAMPLE_NOTES, { confirmResult: true });
    await expect(page.locator(".item")).toHaveCount(2);

    // 「すべて削除」ボタンをクリック
    await page.click("#btn-empty");

    // empty_trash invoke が呼ばれてリストが空になる
    await expect(page.locator(".item")).toHaveCount(0);
    await expect(page.locator(".empty-msg")).toHaveText("ゴミ箱は空です");

    const calls = await page.evaluate(() =>
      (window as any).__captured_invokes.filter((c: any) => c.cmd === "empty_trash")
    );
    expect(calls).toHaveLength(1);
  });

  test("「すべて削除」→ confirm キャンセル → 何も変わらない", async ({ openTrashE2E }) => {
    const page = await openTrashE2E(SAMPLE_NOTES, { confirmResult: false });
    await expect(page.locator(".item")).toHaveCount(2);

    await page.click("#btn-empty");

    // キャンセルしたのでリストは変わらない
    await expect(page.locator(".item")).toHaveCount(2);

    // empty_trash invoke が呼ばれていないことを確認
    const calls = await page.evaluate(() =>
      (window as any).__captured_invokes.filter((c: any) => c.cmd === "empty_trash")
    );
    expect(calls).toHaveLength(0);
  });

  test("空のゴミ箱で「すべて削除」→ confirm OK → empty_trash invoke", async ({ openTrashE2E }) => {
    const page = await openTrashE2E([], { confirmResult: true });
    await expect(page.locator(".empty-msg")).toHaveText("ゴミ箱は空です");

    await page.click("#btn-empty");

    const calls = await page.evaluate(() =>
      (window as any).__captured_invokes.filter((c: any) => c.cmd === "empty_trash")
    );
    expect(calls).toHaveLength(1);
  });
});
