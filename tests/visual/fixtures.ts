import { test as base, expect, type Page } from "@playwright/test";

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
  options: { captureInvokes?: boolean; invokeDelays?: Record<string, number> } = {},
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
      const delay = data.invokeDelays[cmd];
      if (delay) await new Promise((r) => setTimeout(r, delay));
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
  }, {
    note,
    settings: { ...DEFAULT_SETTINGS, ...settingsOverrides },
    captureInvokes: !!options.captureInvokes,
    invokeDelays: options.invokeDelays ?? {},
  });
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
// #markdown-view 自体が contenteditable なので「生表示に入る」という別状態は無い。
// 指定行にキャレットを置く操作はすべて window.placeCaretAtRaw 経由（クリック相当も含めて
// 決め打ちできるよう、実クリックの代わりにこちらを使う）。

/**
 * 指定行の指定列に直接キャレットを置く（col 省略で行末）。
 * macOS の Chromium では Home/End がキャレットを動かさないため、
 * 行内の位置を決め打ちしたいテストはこちらを使う。
 */
export async function placeCaret(page: Page, line: number, col?: number) {
  await page.evaluate(
    ([l, c]) => (window as unknown as { placeCaretAtRaw(l: number, c: number | null): void })
      .placeCaretAtRaw(l as number, (c ?? null) as number | null),
    [line, col] as const,
  );
}

/** 指定行の行末へキャレットを置く（省略時は最終行）。 */
export async function enterEdit(page: Page, lineIndex?: number) {
  const lineCount = await page.evaluate(() => (window as unknown as { getRawContent(): string })
    .getRawContent().split("\n").length);
  await placeCaret(page, lineIndex ?? lineCount - 1);
}

/** 付箋のソーステキスト全体（rawContent は常に最新）。 */
export function getContent(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { getRawContent(): string }).getRawContent());
}

type CaretPosition = { line: number; col: number } | null;

/** 現在のキャレット（collapsed のときのみ、非 collapsed や範囲外なら null）の (line, col)。
 * note.js 本体と同じ resolveSelectionPoint で求めるため、行に装飾（可視 ≠ raw）があっても
 * 正しい raw 列が取れる（DOM のテキスト長から単純に逆算する自前実装は装飾のある行では壊れる）。 */
export function getCaretPosition(page: Page): Promise<CaretPosition> {
  return page.evaluate(() => (window as unknown as { getCaretRawPosition(): CaretPosition }).getCaretRawPosition());
}

type RevealState = { line: number; start: number; end: number } | null;

/** インライン生表示（reveal）の状態を返す（{line, start, end} | null）。 */
export function getRevealState(page: Page): Promise<RevealState> {
  return page.evaluate(() => (window as unknown as { getRevealState(): RevealState }).getRevealState());
}

/** 保留中の保存デバウンスをその場で確定させ、history.commit を積ませる。実時間の待機
 * （waitForTimeout）は CI の遅いランナーでデバウンス窓を越えられず flaky になるため、
 * undo/redo の手数を検証するテストはこちらで決定的に確定を待つ。 */
export async function commitHistory(page: Page) {
  await page.evaluate(() => (window as unknown as { flushContent(): Promise<void> }).flushContent());
}

/** reveal の状態が expected になるまで待つ。selectionchange 駆動で非同期に確定するため、
 * 見た目（.md-reveal の有無）をアサートする前にこれで確定を待つとちらつきに引っかからない。 */
export async function waitForReveal(page: Page, expected: RevealState) {
  await page.waitForFunction(
    (exp) => {
      const state = (window as unknown as { getRevealState(): RevealState }).getRevealState();
      if (exp === null) return state === null;
      return !!state && state.line === exp.line && state.start === exp.start && state.end === exp.end;
    },
    expected,
  );
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

/** 現在の選択の焦点（focus）だけを (line, 可視オフセット) の位置まで Selection.extend() で
 * 伸ばす。ドラッグ選択（mousedown で anchor を置き、mousemove/mouseup で伸びる）の「伸びる」側を
 * 模す。事前に placeCaret 等で anchor（collapsed キャレット）を置いてから呼ぶ。 */
export function extendSelectionTo(page: Page, line: number, visibleOffset: number) {
  return page.evaluate(
    ([l, o]) => {
      const walker = document.createTreeWalker(
        document.querySelector(`#markdown-view [data-line="${l}"]`)!,
        NodeFilter.SHOW_TEXT,
      );
      let remaining = o as number;
      let node: Text | null;
      let last: Text | null = null;
      while ((node = walker.nextNode() as Text | null)) {
        last = node;
        if (remaining <= node.textContent!.length) break;
        remaining -= node.textContent!.length;
      }
      const target = node ?? last;
      if (!target) return;
      window.getSelection()!.extend(target, node ? remaining : target.textContent!.length);
    },
    [line, visibleOffset] as const,
  );
}

// ── Caret geometry helpers ──────────────────────────────────
// raw・DOM 上のキャレット位置が正しくても、見た目の位置・可視性はそれとずれうる（行末スペースが
// white-space: normal で潰れる／空チェックボックス項目でキャレットが div 直下＝チェックボックス
// の位置に見える／コードブロック末尾の空行が描画されず行が無い、等）。caretRect/charRect は
// 実際のピクセル位置（getBoundingClientRect）まで見て、見た目が期待どおりかを機械的に検証する。

type CaretGeometry = { x: number; y: number; height: number } | null;

/** 幅 0 の Range は空の rect（Range.getClientRects() が長さ 0）を返すエンジンがあるため、
 * 直後（無ければ直前）の 1 文字分に広げた Range で代わりに測る。広げた側と逆の端
 * （直後に広げたなら左端、直前に広げたなら右端）が、元の幅 0 位置に対応する。テキストノード
 * 末尾（行送り境界）は、直後の要素を naive な同一点測定より先に見る（下記 rectAtPoint 内コメント
 * 参照）。page.evaluate に渡す関数はクロージャを持てないため、caretRect/charRect それぞれの
 * evaluate 内に同じ実装を書く。expectCaretAtVisiblePosition は両者が同じ測定規則であることを
 * 前提に比較するため、一方を変更したら必ずもう一方も同じ内容に揃えること。 */
type RectAtPoint = (node: Node, offset: number) => CaretGeometry;

/** 現在の DOM 選択（collapsed のときのみ）が視覚的に占める位置。非 collapsed や選択が無いときは null。 */
export function caretRect(page: Page): Promise<CaretGeometry> {
  return page.evaluate(() => {
    const rectAtPoint: RectAtPoint = (node, offset) => {
      const measure = (sn: Node, so: number, en: Node, eo: number) => {
        const r = document.createRange();
        r.setStart(sn, so);
        r.setEnd(en, eo);
        const rects = r.getClientRects();
        if (rects.length) return rects[rects.length - 1];
        const rect = r.getBoundingClientRect();
        return (rect.width > 0 || rect.height > 0) ? rect : null;
      };
      if (node.nodeType === Node.TEXT_NODE) {
        const len = node.textContent!.length;
        if (offset === len) {
          // テキストノード末尾（例: コードブロックの内容行末の "\n"）の幅 0 Range は、
          // 「前の行の末尾」と「次の行の先頭」のどちらの矩形を返すかがエンジン依存
          // （WebKit は前者を返す）。実際にキャレットが視覚的に立つのは次の行の先頭側
          // （<br> フィラー等）なので、後続ノードがあれば同じ点の naive な測定より先に見る
          const sib = node.nextSibling;
          if (sib?.nodeType === Node.TEXT_NODE && sib.textContent!.length > 0) {
            const r = measure(sib, 0, sib, 1);
            if (r) return { x: r.left, y: r.top, height: r.height };
          } else if (sib?.nodeType === Node.ELEMENT_NODE) {
            const er = (sib as Element).getBoundingClientRect();
            if (er.width > 0 || er.height > 0) return { x: er.left, y: er.top, height: er.height };
          }
        } else {
          const r = measure(node, offset, node, offset + 1);
          if (r) return { x: r.left, y: r.top, height: r.height };
        }
      }
      const rect = measure(node, offset, node, offset);
      if (rect) return { x: rect.left, y: rect.top, height: rect.height };
      if (node.nodeType === Node.TEXT_NODE && offset > 0) {
        const r = measure(node, offset - 1, node, offset);
        if (r) return { x: r.right, y: r.top, height: r.height };
      }
      return null;
    };
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    return rectAtPoint(range.startContainer, range.startOffset);
  });
}

/** #markdown-view の指定行（data-line）で、可視オフセット visibleOffset の文字境界が
 * 視覚的に占める位置。note.js の nodeAt/domPointForContentVisible と同じ TreeWalker 走査を
 * ページ内で組み立てる（selectMarkdownRange の pointAtInPage と同じアルゴリズム）ため、
 * note.js 側のキャレット配置ロジックとは独立に「この可視オフセットは本来どこに見えるべきか」
 * を求められる。該当行が無ければ null。 */
export function charRect(page: Page, line: number, visibleOffset: number): Promise<CaretGeometry> {
  return page.evaluate(
    ([l, o]) => {
      const rectAtPoint: RectAtPoint = (node, offset) => {
        const measure = (sn: Node, so: number, en: Node, eo: number) => {
          const r = document.createRange();
          r.setStart(sn, so);
          r.setEnd(en, eo);
          const rects = r.getClientRects();
          if (rects.length) return rects[rects.length - 1];
          const rect = r.getBoundingClientRect();
          return (rect.width > 0 || rect.height > 0) ? rect : null;
        };
        const rect = measure(node, offset, node, offset);
        if (rect) return { x: rect.left, y: rect.top, height: rect.height };
        if (node.nodeType === Node.TEXT_NODE) {
          const len = node.textContent!.length;
          if (offset < len) {
            const r = measure(node, offset, node, offset + 1);
            if (r) return { x: r.left, y: r.top, height: r.height };
          }
          if (offset > 0) {
            const r = measure(node, offset - 1, node, offset);
            if (r) return { x: r.right, y: r.top, height: r.height };
          }
        }
        return null;
      };
      const el = document.querySelector(`#markdown-view [data-line="${l}"]`);
      if (!el) return null;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let remaining = o as number;
      let node: Text | null;
      let last: Text | null = null;
      while ((node = walker.nextNode() as Text | null)) {
        last = node;
        if (remaining <= node.textContent!.length) break;
        remaining -= node.textContent!.length;
      }
      const target = node ?? last;
      if (!target) return null;
      const offset = node ? remaining : target.textContent!.length;
      return rectAtPoint(target, offset);
    },
    [line, visibleOffset] as const,
  );
}

/** 現在のキャレット（collapsed）が、指定行の可視オフセット visibleOffset の位置に視覚的に
 * 一致することを assert する（x/y とも許容誤差 tolerance px 以内）。フォントレンダリングの
 * 微差を吸収しつつ、DOM・raw は正しいが見た目の位置がずれるバグを検出する。 */
export async function expectCaretAtVisiblePosition(
  page: Page,
  line: number,
  visibleOffset: number,
  tolerance = 2,
) {
  const [actual, expected] = await Promise.all([caretRect(page), charRect(page, line, visibleOffset)]);
  expect(actual, `caret rect not found (line=${line})`).not.toBeNull();
  expect(expected, `char rect not found (line=${line}, visibleOffset=${visibleOffset})`).not.toBeNull();
  expect(Math.abs(actual!.x - expected!.x), `x mismatch: actual=${actual!.x} expected=${expected!.x}`)
    .toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual!.y - expected!.y), `y mismatch: actual=${actual!.y} expected=${expected!.y}`)
    .toBeLessThanOrEqual(tolerance);
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
