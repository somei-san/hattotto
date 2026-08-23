import { test, expect } from "./fixtures";

test.describe("リンククリック", () => {
  test("Markdownリンクをクリック → shell.open()が呼ばれる", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();

    // shell.open の呼び出しを記録するモックを注入
    await page.addInitScript(() => {
      const openCalls: string[] = [];
      (window as any).__shell_open_calls = openCalls;

      type EventHandler = (...args: unknown[]) => void;
      const globalListeners: Record<string, EventHandler[]> = {};
      const appWindowListeners: Record<string, EventHandler[]> = {};
      (window as any).__globalListeners = globalListeners;
      (window as any).__appWindowListeners = appWindowListeners;

      (window as any).__TAURI__ = {
        core: {
          invoke: async (cmd: string) => {
            switch (cmd) {
              case "get_note":
                return {
                  id: "test-note-id",
                  content: "[Example](https://example.com)",
                  color: "yellow",
                  x: 0, y: 0, width: 300, height: 350, zoom: 100, pinned: false,
                };
              case "get_settings":
                return {
                  default_color: "yellow", opacity: 100,
                  bring_all_to_front: true, show_pin_button: true, show_new_button: true,
                  show_color_button: true, confirm_before_delete: true, language: "ja",
                  system_language: "ja",
                };
              default: return null;
            }
          },
        },
        event: {
          listen: async (event: string, handler: EventHandler) => {
            if (!globalListeners[event]) globalListeners[event] = [];
            globalListeners[event].push(handler);
            return () => {};
          },
        },
        shell: {
          open: async (url: string) => { openCalls.push(url); },
        },
        webviewWindow: {
          getCurrentWebviewWindow: () => ({
            startDragging: async () => {},
            outerPosition: async () => ({ x: 0, y: 0 }),
            outerSize: async () => ({ width: 300, height: 350 }),
            setAlwaysOnTop: async () => {},
            isFocused: async () => true,
            onMoved: async () => async () => {},
            onResized: async () => async () => {},
            listen: async (event: string, handler: EventHandler) => {
              if (!appWindowListeners[event]) appWindowListeners[event] = [];
              appWindowListeners[event].push(handler);
              return () => {};
            },
          }),
        },
      };
    });

    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    // プレビューモードでリンクが表示されていることを確認
    await expect(page.locator(".markdown-view")).toBeVisible();
    const link = page.locator("a[data-url]");
    await expect(link).toBeVisible();

    // リンクをクリック
    await link.click();

    // shell.open が正しいURLで呼ばれたことを確認
    const calls = await page.evaluate(() => (window as any).__shell_open_calls);
    expect(calls).toEqual(["https://example.com"]);

    await ctx.close();
  });

  test("リンククリック後 → その行は生 Markdown にならない", async ({ openNote }) => {
    const page = await openNote({ content: "[Example](https://example.com)" });

    const link = page.locator("a[data-url]");
    await expect(link).toBeVisible();

    // リンクをクリック
    await link.click();

    // 描画されたままであることを確認
    await expect(link).toBeVisible();
    await expect(page.locator("#editor")).toHaveCount(0);
  });
});
