import { test as base, type Page } from "@playwright/test";

// ── Shared defaults ────────────────────────────────────────

const DEFAULT_SETTINGS = {
  default_color: "yellow",
  font_size: 14,
  zoom: 100,
  opacity: 100,
  edit_on_single_click: false,
};

// ── Note mock ──────────────────────────────────────────────

async function injectNoteMock(
  page: Page,
  noteOverrides: Record<string, unknown> = {},
  settingsOverrides: Record<string, unknown> = {},
) {
  const note = {
    id: "test-note-id",
    content: "",
    color: "yellow",
    x: 0,
    y: 0,
    width: 300,
    height: 350,
    zoom: 100,
    ...noteOverrides,
  };

  await page.addInitScript((data) => {
    (window as any).__TAURI__ = {
      core: {
        invoke: async (cmd: string) => {
          switch (cmd) {
            case "get_note":              return data.note;
            case "get_settings":          return data.settings;
            case "update_note_content":   return null;
            case "update_note_color":     return null;
            case "update_note_geometry":  return null;
            case "update_note_zoom":      return null;
            case "update_settings":       return null;
            case "delete_note":           return null;
            case "create_note":           return null;
            default:                      return null;
          }
        },
      },
      event: {
        listen: async () => () => {},
      },
      shell: {
        open: async () => {},
      },
      webviewWindow: {
        getCurrentWebviewWindow: () => ({
          startDragging: async () => {},
          outerPosition: async () => ({ x: 0, y: 0 }),
          outerSize: async () => ({ width: 300, height: 350 }),
          isFocused: async () => true,
        }),
      },
    };
  }, { note, settings: { ...DEFAULT_SETTINGS, ...settingsOverrides } });
}

// ── Settings mock ──────────────────────────────────────────

async function injectSettingsMock(
  page: Page,
  settingsOverrides: Record<string, unknown> = {},
  autostartEnabled = false,
) {
  const settings = { ...DEFAULT_SETTINGS, ...settingsOverrides };

  await page.addInitScript((data) => {
    (window as any).__TAURI__ = {
      core: {
        invoke: async (cmd: string) => {
          switch (cmd) {
            case "get_settings":               return data.settings;
            case "update_settings":            return null;
            case "plugin:autostart|is_enabled": return data.autostart;
            case "plugin:autostart|enable":    return null;
            case "plugin:autostart|disable":   return null;
            default:                           return null;
          }
        },
      },
      event: {
        emit: async () => {},
      },
    };
  }, { settings, autostart: autostartEnabled });
}

// ── Fixture types ──────────────────────────────────────────

type Fixtures = {
  notePage: Page;
  openNote: (overrides?: Record<string, unknown>, settings?: Record<string, unknown>) => Promise<Page>;
  settingsPage: Page;
  openSettings: (overrides?: Record<string, unknown>, autostart?: boolean) => Promise<Page>;
};

export const test = base.extend<Fixtures>({
  // note.html — default yellow, empty
  notePage: async ({ page }, use) => {
    await injectNoteMock(page);
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");
    await use(page);
  },

  // note.html — custom note data, own browser context
  openNote: async ({ browser }, use) => {
    const pages: Page[] = [];
    const open = async (overrides: Record<string, unknown> = {}, settings: Record<string, unknown> = {}) => {
      const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
      const page = await ctx.newPage();
      await injectNoteMock(page, overrides, settings);
      await page.goto("/note.html?id=test-note-id");
      await page.waitForLoadState("networkidle");
      pages.push(page);
      return page;
    };
    await use(open);
    for (const p of pages) await p.context().close();
  },

  // settings.html — default settings
  settingsPage: async ({ page }, use) => {
    await page.setViewportSize({ width: 420, height: 520 });
    await injectSettingsMock(page, {}, false);
    await page.goto("/settings.html");
    await page.waitForLoadState("networkidle");
    await use(page);
  },

  // settings.html — custom settings, own browser context (420x520)
  openSettings: async ({ browser }, use) => {
    const pages: Page[] = [];
    const open = async (overrides: Record<string, unknown> = {}, autostart = false) => {
      const ctx = await browser.newContext({ viewport: { width: 420, height: 520 } });
      const page = await ctx.newPage();
      await injectSettingsMock(page, overrides, autostart);
      await page.goto("/settings.html");
      await page.waitForLoadState("networkidle");
      pages.push(page);
      return page;
    };
    await use(open);
    for (const p of pages) await p.context().close();
  },
});

export { expect } from "@playwright/test";
