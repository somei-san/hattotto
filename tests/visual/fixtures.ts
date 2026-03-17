import { test as base, type Page } from "@playwright/test";

/**
 * Tauri API mock injected before page scripts execute.
 * Stubs window.__TAURI__ so note.html runs without the Tauri runtime.
 */
async function injectTauriMock(page: Page, noteOverrides: Record<string, unknown> = {}) {
  const defaultNote = {
    id: "test-note-id",
    content: "",
    color: "yellow",
    x: 0,
    y: 0,
    width: 300,
    height: 350,
    ...noteOverrides,
  };

  await page.addInitScript((note) => {
    (window as any).__TAURI__ = {
      core: {
        invoke: async (cmd: string, _args?: Record<string, unknown>) => {
          switch (cmd) {
            case "get_note":
              return note;
            case "update_note_content":
            case "update_note_color":
            case "update_note_geometry":
            case "delete_note":
            case "create_note":
              return null;
            default:
              console.warn(`[mock] unknown command: ${cmd}`);
              return null;
          }
        },
      },
      webviewWindow: {
        getCurrentWebviewWindow: () => ({
          startDragging: async () => {},
          outerPosition: async () => ({ x: 0, y: 0 }),
          outerSize: async () => ({ width: 300, height: 350 }),
        }),
      },
    };
  }, defaultNote);
}

type NoteFixtures = {
  notePage: Page;
  openNote: (overrides?: Record<string, unknown>) => Promise<Page>;
};

export const test = base.extend<NoteFixtures>({
  notePage: async ({ page }, use) => {
    await injectTauriMock(page);
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");
    await use(page);
  },

  openNote: async ({ browser }, use) => {
    const pages: Page[] = [];

    const open = async (overrides: Record<string, unknown> = {}) => {
      const context = await browser.newContext({
        viewport: { width: 300, height: 350 },
      });
      const page = await context.newPage();
      await injectTauriMock(page, overrides);
      await page.goto("/note.html?id=test-note-id");
      await page.waitForLoadState("networkidle");
      pages.push(page);
      return page;
    };

    await use(open);

    for (const p of pages) {
      await p.context().close();
    }
  },
});

export { expect } from "@playwright/test";
