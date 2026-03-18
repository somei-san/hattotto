import { test, expect } from "./fixtures";
import { type Page, type Browser } from "@playwright/test";

/** Create a page with a Tauri mock that captures `update_note_content` calls. */
async function openNoteWithCapture(browser: Browser, content: string): Promise<{ page: Page; ctx: import("@playwright/test").BrowserContext }> {
  const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
  const page = await ctx.newPage();

  await page.addInitScript((noteContent: string) => {
    (window as any).__capturedContent = [];
    (window as any).__TAURI__ = {
      core: {
        invoke: async (cmd: string, args: any) => {
          if (cmd === "update_note_content") {
            (window as any).__capturedContent.push(args.content);
          }
          switch (cmd) {
            case "get_note":
              return { id: "test-note-id", content: noteContent, color: "yellow", x: 0, y: 0, width: 300, height: 350, zoom: 100 };
            case "get_settings":
              return { default_color: "yellow", font_size: 14, zoom: 100, opacity: 100, edit_on_single_click: false };
            default:
              return null;
          }
        },
      },
      event: { listen: async () => () => {} },
      shell: { open: async () => {} },
      webviewWindow: {
        getCurrentWebviewWindow: () => ({
          startDragging: async () => {},
          outerPosition: async () => ({ x: 0, y: 0 }),
          outerSize: async () => ({ width: 300, height: 350 }),
          isFocused: async () => true,
        }),
      },
    };
  }, content);

  await page.goto("/note.html?id=test-note-id");
  await page.waitForLoadState("networkidle");
  return { page, ctx };
}

test.describe("checkbox toggle interaction", () => {
  test("clicking unchecked checkbox calls update with checked content", async ({ browser }) => {
    const { page, ctx } = await openNoteWithCapture(browser, "- [ ] task");

    const checkbox = page.locator('input[type="checkbox"]').first();
    await checkbox.click();
    await page.waitForTimeout(400);

    const captured = await page.evaluate(() => (window as any).__capturedContent);
    expect(captured.length).toBeGreaterThan(0);
    const lastContent = captured[captured.length - 1];
    expect(lastContent).toContain("- [x] task");

    await ctx.close();
  });

  test("clicking checked checkbox calls update with unchecked content", async ({ browser }) => {
    const { page, ctx } = await openNoteWithCapture(browser, "- [x] done");

    const checkbox = page.locator('input[type="checkbox"]').first();
    await checkbox.click();
    await page.waitForTimeout(400);

    const captured = await page.evaluate(() => (window as any).__capturedContent);
    expect(captured.length).toBeGreaterThan(0);
    const lastContent = captured[captured.length - 1];
    expect(lastContent).toContain("- [ ] done");

    await ctx.close();
  });
});
