import { test as base, type Page } from "@playwright/test";

// ── Shared defaults ────────────────────────────────────────

const DEFAULT_SETTINGS = {
  default_color: "yellow",
  font_size: 14,
  zoom: 100,
  opacity: 100,
  edit_on_single_click: false,
  bring_all_to_front: true,
  show_pin_button: true,
  show_new_button: true,
  show_color_button: true,
  confirm_before_delete: true,
};

// ── Note mock ──────────────────────────────────────────────

export async function injectNoteMock(
  page: Page,
  noteOverrides: Record<string, unknown> = {},
  settingsOverrides: Record<string, unknown> = {},
  options: { captureInvokes?: boolean } = {},
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
    pinned: false,
    ...noteOverrides,
  };

  await page.addInitScript((data) => {
    const baseMock = async (cmd: string, args?: unknown) => {
      switch (cmd) {
        case "get_note":              return data.note;
        case "get_settings":          return data.settings;
        case "update_note_content":   return null;
        case "update_note_color":     return null;
        case "update_note_geometry":  return null;
        case "update_note_zoom":      return null;
        case "update_note_pinned":    return null;
        case "update_settings":       return null;
        case "delete_note":           return null;
        case "create_note":           return null;
        case "bring_other_notes_to_front": return null;
        default:                      return null;
      }
    };

    let invoke: (cmd: string, args?: unknown) => Promise<unknown> = baseMock;
    if (data.captureInvokes) {
      const calls: { cmd: string; args: unknown }[] = [];
      (window as any).__captured_invokes = calls;
      invoke = async (cmd: string, args?: unknown) => {
        calls.push({ cmd, args });
        return baseMock(cmd, args);
      };
    }

    // Track which events are registered on global listen vs appWindow.listen
    const globalListeners: Record<string, Function[]> = {};
    const appWindowListeners: Record<string, Function[]> = {};
    (window as any).__globalListeners = globalListeners;
    (window as any).__appWindowListeners = appWindowListeners;

    (window as any).__TAURI__ = {
      core: { invoke },
      event: {
        listen: async (event: string, handler: Function) => {
          if (!globalListeners[event]) globalListeners[event] = [];
          globalListeners[event].push(handler);
          return () => {};
        },
      },
      shell: {
        open: async () => {},
      },
      webviewWindow: {
        getCurrentWebviewWindow: () => ({
          startDragging: async () => {},
          outerPosition: async () => ({ x: 0, y: 0 }),
          outerSize: async () => ({ width: 300, height: 350 }),
          setAlwaysOnTop: async () => {},
          isFocused: async () => true,
          listen: async (event: string, handler: Function) => {
            if (!appWindowListeners[event]) appWindowListeners[event] = [];
            appWindowListeners[event].push(handler);
            return () => {};
          },
        }),
      },
    };
  }, { note, settings: { ...DEFAULT_SETTINGS, ...settingsOverrides }, captureInvokes: !!options.captureInvokes });
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
        listen: async () => () => {},
      },
      webviewWindow: {
        getCurrentWebviewWindow: () => ({
          close: async () => { (window as any).__closeWasCalled = true; },
        }),
      },
    };
  }, { settings, autostart: autostartEnabled });
}

// ── Trash mock ────────────────────────────────────────────

async function injectTrashMock(
  page: Page,
  trashItems: Record<string, unknown>[] = [],
) {
  await page.addInitScript((data) => {
    (window as any).__TAURI__ = {
      core: {
        invoke: async (cmd: string) => {
          switch (cmd) {
            case "get_trash":     return data.items;
            case "get_trash_max": return 200;
            case "restore_note":  return null;
            case "empty_trash":   return null;
            default:              return null;
          }
        },
      },
    };
  }, { items: trashItems });
}

// ── Fixture types ──────────────────────────────────────────

type Fixtures = {
  notePage: Page;
  openNote: (overrides?: Record<string, unknown>, settings?: Record<string, unknown>) => Promise<Page>;
  settingsPage: Page;
  openSettings: (overrides?: Record<string, unknown>, autostart?: boolean) => Promise<Page>;
  trashPage: Page;
  openTrash: (items?: Record<string, unknown>[]) => Promise<Page>;
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

  // trash.html — default empty trash
  trashPage: async ({ page }, use) => {
    await page.setViewportSize({ width: 360, height: 480 });
    await injectTrashMock(page);
    await page.goto("/trash.html");
    await page.waitForLoadState("networkidle");
    await use(page);
  },

  // trash.html — custom trash data, own browser context (360x480)
  openTrash: async ({ browser }, use) => {
    const pages: Page[] = [];
    const open = async (items: Record<string, unknown>[] = []) => {
      const ctx = await browser.newContext({ viewport: { width: 360, height: 480 } });
      const page = await ctx.newPage();
      await injectTrashMock(page, items);
      await page.goto("/trash.html");
      await page.waitForLoadState("networkidle");
      pages.push(page);
      return page;
    };
    await use(open);
    for (const p of pages) await p.context().close();
  },
});

export { expect } from "@playwright/test";
