import { test as base, type Page } from "@playwright/test";

// ── Shared defaults ────────────────────────────────────────

const DEFAULT_SETTINGS = {
  default_color: "yellow",
  opacity: 100,
  bring_all_to_front: true,
  show_pin_button: true,
  show_new_button: true,
  show_color_button: true,
  confirm_before_delete: true,
  language: "ja",
  system_language: "ja",
  data_dir: "/mock/data-dir",
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
        case "save_pasted_image":     return "images/00000000-0000-4000-8000-000000000001.png";
        case "show_context_menu":     return null;
        case "open_image":            return null;
        case "delete_image":          return null;
        case "copy_image":            return null;
        case "cut_image":             return null;
        case "copy_markdown":         return null;
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
    type EventHandler = (...args: unknown[]) => void;
    const globalListeners: Record<string, EventHandler[]> = {};
    const appWindowListeners: Record<string, EventHandler[]> = {};
    (window as any).__globalListeners = globalListeners;
    (window as any).__appWindowListeners = appWindowListeners;

    (window as any).__TAURI__ = {
      core: {
        invoke,
        convertFileSrc: (path: string) => `asset://localhost/${path}`,
      },
      event: {
        listen: async (event: string, handler: EventHandler) => {
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
          onMoved: async (_handler: EventHandler) => async () => {},
          onResized: async (_handler: EventHandler) => async () => {},
          listen: async (event: string, handler: EventHandler) => {
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
    const shellOpenCalls: string[] = [];
    (window as any).__shell_open_calls = shellOpenCalls;
    const emittedEvents: { event: string; payload: unknown }[] = [];
    (window as any).__emitted_events = emittedEvents;

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
        emit: async (event: string, payload: unknown) => { emittedEvents.push({ event, payload }); },
        listen: async () => () => {},
      },
      app: {
        getVersion: async () => "0.1.0",
      },
      shell: {
        open: async (url: string) => { shellOpenCalls.push(url); },
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
  settingsOverrides: Record<string, unknown> = {},
) {
  const settings = { ...DEFAULT_SETTINGS, ...settingsOverrides };

  await page.addInitScript((data) => {
    type EventHandler = (...args: unknown[]) => void;
    const globalListeners: Record<string, EventHandler[]> = {};
    (window as any).__globalListeners = globalListeners;

    (window as any).__TAURI__ = {
      core: {
        invoke: async (cmd: string) => {
          switch (cmd) {
            case "get_trash":     return data.items;
            case "get_trash_max": return 200;
            case "get_settings":  return data.settings;
            case "restore_note":  return null;
            case "empty_trash":   return null;
            default:              return null;
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
      webviewWindow: {
        getCurrentWebviewWindow: () => ({
          close: async () => {},
        }),
      },
    };
  }, { items: trashItems, settings });
}

// ── Editor helpers ─────────────────────────────────────────

/**
 * 指定行をクリックして生表示にする。省略時は最終行。
 * 生表示中の行だけが `#editor`（`.raw-editor`）になる。
 */
export async function enterEdit(page: Page, lineIndex?: number) {
  if (lineIndex == null) {
    await page.click("#markdown-view");
  } else {
    await page.locator(`#markdown-view [data-line="${lineIndex}"]`).first().click();
  }
  await page.waitForSelector("#editor", { state: "visible" });
}

/**
 * 指定行の指定列に直接キャレットを置く（col 省略で行末）。
 * macOS の Chromium では Home/End がキャレットを動かさないため、
 * 行内の位置を決め打ちしたいテストはこちらを使う。
 */
export async function placeCaret(page: Page, line: number, col?: number) {
  await page.evaluate(
    ([l, c]) => (window as unknown as { enterLine(l: number, c: number | null): void })
      .enterLine(l as number, (c ?? null) as number | null),
    [line, col] as const,
  );
  await page.waitForSelector("#editor", { state: "visible" });
}

/** 生表示中の行を書き戻したうえでの、付箋のソーステキスト全体。 */
export function getContent(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { getRawContent(): string }).getRawContent());
}

/** markdown-view の (行, 可視オフセット) の 2 点を DOM 選択（Range）として張る。note.js の
 * nodeAt と同じアルゴリズムをページ内で組み立てる（行末を超えるオフセットは行末にクランプ）。 */
export function selectMarkdownRange(
  page: Page,
  startLine: number,
  startOffset: number,
  endLine: number,
  endOffset: number,
) {
  return page.evaluate(
    ([sl, so, el, eo]) => {
      const pointAtInPage = (elm: Element, visibleOffset: number) => {
        const walker = document.createTreeWalker(elm, NodeFilter.SHOW_TEXT);
        let remaining = visibleOffset;
        let node: Text | null;
        let last: Text | null = null;
        while ((node = walker.nextNode() as Text | null)) {
          last = node;
          if (remaining <= node.textContent!.length) return { node, offset: remaining };
          remaining -= node.textContent!.length;
        }
        return last ? { node: last, offset: last.textContent!.length } : { node: elm, offset: 0 };
      };
      const startEl = document.querySelector(`#markdown-view [data-line="${sl}"]`)!;
      const endEl = document.querySelector(`#markdown-view [data-line="${el}"]`)!;
      const start = pointAtInPage(startEl, so as number);
      const end = pointAtInPage(endEl, eo as number);
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    },
    [startLine, startOffset, endLine, endOffset] as const,
  );
}

// ── Fixture types ──────────────────────────────────────────

type Fixtures = {
  notePage: Page;
  openNote: (overrides?: Record<string, unknown>, settings?: Record<string, unknown>) => Promise<Page>;
  settingsPage: Page;
  openSettings: (overrides?: Record<string, unknown>, autostart?: boolean) => Promise<Page>;
  trashPage: Page;
  openTrash: (items?: Record<string, unknown>[], settings?: Record<string, unknown>) => Promise<Page>;
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
    const open = async (items: Record<string, unknown>[] = [], settings: Record<string, unknown> = {}) => {
      const ctx = await browser.newContext({ viewport: { width: 360, height: 480 } });
      const page = await ctx.newPage();
      await injectTrashMock(page, items, settings);
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
