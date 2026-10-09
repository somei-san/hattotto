use std::time::Instant;

use tauri::{
    AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, State, WebviewUrl,
    WebviewWindowBuilder,
};

use crate::i18n::{self, Msg};
use crate::model::{
    clamp_opacity, clamp_zoom, is_valid_color_key, resolve_color, AppState, Note, RecoverMutex,
    COLOR_DEFS, DEFAULT_POSITION, DEFAULT_SIZE,
};
use crate::persistence::save_notes;

// ── Monitor geometry (pure functions for testability) ────────

/// Logical bounds of a monitor or window: (x, y, width, height).
pub(crate) struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    fn overlaps(&self, other: &Rect) -> bool {
        self.x < other.x + other.w
            && other.x < self.x + self.w
            && self.y < other.y + other.h
            && other.y < self.y + self.h
    }
}

/// Check if (x, y) is inside any monitor (with 50px margin).
/// Returns the original coordinates if inside, or default position
/// offset from `primary_origin` if outside all monitors.
pub(crate) fn clamp_position(
    x: f64,
    y: f64,
    monitors: &[Rect],
    primary_origin: (f64, f64),
) -> (f64, f64) {
    for m in monitors {
        if x >= m.x && x < m.x + m.w - 50.0 && y >= m.y && y < m.y + m.h - 50.0 {
            return (x, y);
        }
    }
    (
        primary_origin.0 + DEFAULT_POSITION.0,
        primary_origin.1 + DEFAULT_POSITION.1,
    )
}

// ── Note Creation Helper ────────────────────────────────────

const CASCADE_STEP: f64 = 30.0;
/// Gap between the anchor and a new note placed beside it.
const BESIDE_GAP: f64 = 10.0;

/// A window as seen when choosing the anchor of a new note.
pub(crate) struct WindowSnapshot {
    pub label: String,
    pub focused: bool,
    /// Physical outer position.
    pub position: (i32, i32),
    /// Physical outer size.
    pub size: (u32, u32),
    pub scale_factor: f64,
}

impl WindowSnapshot {
    fn is_note(&self) -> bool {
        self.label.starts_with("note-")
    }

    fn logical_rect(&self) -> Rect {
        let sf = self.scale_factor;
        Rect {
            x: self.position.0 as f64 / sf,
            y: self.position.1 as f64 / sf,
            w: self.size.0 as f64 / sf,
            h: self.size.1 as f64 / sf,
        }
    }
}

/// The note a new note is placed relative to, in logical coordinates.
pub(crate) struct Anchor {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// Whether the anchor note has no content yet.
    pub empty: bool,
}

impl Anchor {
    pub(crate) fn new(window: &WindowSnapshot, empty: bool) -> Self {
        let Rect { x, y, w, h } = window.logical_rect();
        Self { x, y, w, h, empty }
    }
}

/// The note window a new note should be placed relative to.
/// `anchor_label` names it explicitly (the note whose button or context menu
/// was used); otherwise the focused note window is used. Non-note windows
/// (settings, trash) are never anchors.
pub(crate) fn pick_anchor<'a>(
    windows: &'a [WindowSnapshot],
    anchor_label: Option<&str>,
) -> Option<&'a WindowSnapshot> {
    let is_anchor = |w: &&WindowSnapshot| match anchor_label {
        Some(label) => w.label == label,
        None => w.focused,
    };
    windows.iter().filter(|w| w.is_note()).find(is_anchor)
}

/// Whether the note shown in the window `label` has no content. A window
/// without a matching note counts as empty.
pub(crate) fn anchor_is_empty(notes: &[Note], label: &str) -> bool {
    match notes.iter().find(|n| label == format!("note-{}", n.id)) {
        Some(note) => note.is_empty(),
        None => true,
    }
}

/// Logical bounds of every note window, used to avoid covering other notes.
pub(crate) fn note_rects(windows: &[WindowSnapshot]) -> Vec<Rect> {
    windows
        .iter()
        .filter(|w| w.is_note())
        .map(WindowSnapshot::logical_rect)
        .collect()
}

/// Position of a new note, kept inside the anchor's monitor (`monitors` are
/// work areas) so it never jumps to the default position near an edge.
/// - Anchor with content: beside it so it stays readable (see `beside`)
/// - Empty anchor: slightly down-right of it, so the user can line up many
///   blank notes in a row before writing them
/// - No anchor: cascade from the default position by the number of notes
pub(crate) fn new_note_position(
    anchor: Option<&Anchor>,
    size: (f64, f64),
    monitors: &[Rect],
    notes: &[Rect],
    note_count: usize,
) -> (f64, f64) {
    let Some(a) = anchor else {
        let offset = ((note_count % 20) as f64) * CASCADE_STEP;
        return (DEFAULT_POSITION.0 + offset, DEFAULT_POSITION.1 + offset);
    };
    let Some(m) = nearest_monitor(a, monitors) else {
        return (a.x + CASCADE_STEP, a.y + CASCADE_STEP);
    };
    let cascade = || {
        (
            place_on_axis(a.x, m.x, m.w, size.0),
            place_on_axis(a.y, m.y, m.h, size.1),
        )
    };
    if a.empty {
        return cascade();
    }
    beside(a, size, m, notes).unwrap_or_else(cascade)
}

/// The monitor the anchor is on. The anchor's top-left can be off every
/// monitor (dragged past the left edge, or in a gap between monitors), so
/// fall back to the nearest one.
fn nearest_monitor<'a>(a: &Anchor, monitors: &'a [Rect]) -> Option<&'a Rect> {
    let distance = |m: &Rect| {
        let dx = (m.x - a.x).max(a.x - (m.x + m.w)).max(0.0);
        let dy = (m.y - a.y).max(a.y - (m.y + m.h)).max(0.0);
        dx * dx + dy * dy
    };
    monitors
        .iter()
        .min_by(|p, q| distance(p).total_cmp(&distance(q)))
}

/// Position of the settings screen's preview: right of the settings window
/// (`a`), or left of it when the right doesn't fit in the monitor. Unlike a
/// new note it never goes below or above, and it may cover notes, since it
/// only shows for a moment. When neither side fits, it is pushed into the
/// monitor from the right and covers the settings window.
pub(crate) fn preview_position(a: &Anchor, size: (f64, f64), monitors: &[Rect]) -> (f64, f64) {
    let right = a.x + a.w + BESIDE_GAP;
    let Some(m) = nearest_monitor(a, monitors) else {
        return (right, a.y);
    };
    let y = a.y.min(m.y + m.h - size.1).max(m.y);
    let left = a.x - size.0 - BESIDE_GAP;
    let x = if right + size.0 <= m.x + m.w {
        right
    } else if left >= m.x {
        left
    } else {
        right.min(m.x + m.w - size.0).max(m.x)
    };
    (x, y)
}

/// A spot right of, left of, below or above the anchor (in that order) that
/// fits in the monitor. Prefers the first one that doesn't cover another note
/// (`notes`); when every spot does, takes the first that fits anyway.
fn beside(a: &Anchor, size: (f64, f64), m: &Rect, notes: &[Rect]) -> Option<(f64, f64)> {
    let fits = |&(x, y): &(f64, f64)| {
        x >= m.x && x + size.0 <= m.x + m.w && y >= m.y && y + size.1 <= m.y + m.h
    };
    let is_free = |&(x, y): &(f64, f64)| {
        let new = Rect {
            x,
            y,
            w: size.0,
            h: size.1,
        };
        !notes.iter().any(|n| n.overlaps(&new))
    };
    // Align with the anchor's top (or left) edge, shifted only as much as
    // needed to stay inside the monitor
    let aligned_y = a.y.min(m.y + m.h - size.1).max(m.y);
    let aligned_x = a.x.min(m.x + m.w - size.0).max(m.x);
    let spots: Vec<(f64, f64)> = [
        (a.x + a.w + BESIDE_GAP, aligned_y),
        (a.x - size.0 - BESIDE_GAP, aligned_y),
        (aligned_x, a.y + a.h + BESIDE_GAP),
        (aligned_x, a.y - size.1 - BESIDE_GAP),
    ]
    .into_iter()
    .filter(fits)
    .collect();
    spots
        .iter()
        .copied()
        .find(is_free)
        .or_else(|| spots.first().copied())
}

/// One axis of `new_note_position`: step forward from the anchor, or step
/// back when that doesn't fit, so the new note never lands exactly on an
/// anchor already at the far edge.
fn place_on_axis(anchor: f64, start: f64, len: f64, size: f64) -> f64 {
    let limit = start + len - size;
    let forward = anchor + CASCADE_STEP;
    if forward <= limit {
        forward.max(start)
    } else {
        (anchor - CASCADE_STEP).min(limit).max(start)
    }
}

fn window_snapshots(app: &AppHandle) -> Vec<WindowSnapshot> {
    app.webview_windows()
        .into_iter()
        .filter_map(|(label, win)| {
            let pos = win.outer_position().ok()?;
            let size = win.outer_size().ok()?;
            Some(WindowSnapshot {
                focused: win.is_focused().unwrap_or(false),
                position: (pos.x, pos.y),
                size: (size.width, size.height),
                scale_factor: win.scale_factor().ok()?,
                label,
            })
        })
        .collect()
}

/// Create a new note relative to the anchor note (see `pick_anchor` and
/// `new_note_position`) and open its window.
/// Shared by create_note command, app menu, context menu, and tray menu.
pub(crate) fn create_note_with_window(
    app: &AppHandle,
    state: &AppState,
    anchor_label: Option<&str>,
) -> Note {
    let (default_color, default_zoom) = {
        let settings = state.settings.recover();
        (settings.default_color.clone(), settings.default_zoom)
    };
    let color = resolve_color(&default_color);
    // Read the live windows rather than the saved notes: geometry is saved
    // with a debounce and may lag right after the user drags a note.
    let windows = window_snapshots(app);
    let anchor_window = pick_anchor(&windows, anchor_label);
    let monitors = work_area_rects(app);
    let mut n = Note::new(&color);
    n.zoom = default_zoom;
    // Only read the notes under the lock; monitor queries stay outside it
    let (x, y) = {
        let notes = state.notes.recover();
        let anchor = anchor_window.map(|w| Anchor::new(w, anchor_is_empty(&notes, &w.label)));
        new_note_position(
            anchor.as_ref(),
            (n.width, n.height),
            &monitors,
            &note_rects(&windows),
            notes.len(),
        )
    };
    // Save the position the window will actually open at
    (n.x, n.y) = clamp_to_screen(app, x, y);
    open_note_window(app, &n);
    let snapshot = {
        let mut notes = state.notes.recover();
        notes.push(n.clone());
        notes.clone()
    };
    if let Err(e) = save_notes(state, &snapshot) {
        log::error!("save notes error: {}", e);
    }
    n
}

// ── Window Management ───────────────────────────────────────

/// モニターの論理座標範囲を確認し、付箋の位置が全モニター外なら
/// プライマリモニター上のデフォルト位置にクランプする。
/// モニター情報が取得できない場合は検証不能なので元の座標をそのまま返す。
fn clamp_to_screen(app: &AppHandle, x: f64, y: f64) -> (f64, f64) {
    let rects = monitor_rects(app);
    if rects.is_empty() {
        return (x, y);
    }
    let primary_origin = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let sf = m.scale_factor();
            (m.position().x as f64 / sf, m.position().y as f64 / sf)
        })
        .unwrap_or((0.0, 0.0));
    clamp_position(x, y, &rects, primary_origin)
}

/// Logical bounds of all monitors. Empty when they can't be retrieved.
fn monitor_rects(app: &AppHandle) -> Vec<Rect> {
    logical_rects(app, |m| (*m.position(), *m.size()))
}

/// Logical work areas (excluding the menu bar and Dock) of all monitors.
fn work_area_rects(app: &AppHandle) -> Vec<Rect> {
    logical_rects(app, |m| (m.work_area().position, m.work_area().size))
}

fn logical_rects(
    app: &AppHandle,
    bounds: impl Fn(&Monitor) -> (PhysicalPosition<i32>, PhysicalSize<u32>),
) -> Vec<Rect> {
    let Ok(monitors) = app.available_monitors() else {
        return Vec::new();
    };
    monitors
        .iter()
        .map(|m| {
            let sf = m.scale_factor();
            let (pos, size) = bounds(m);
            Rect {
                x: pos.x as f64 / sf,
                y: pos.y as f64 / sf,
                w: size.width as f64 / sf,
                h: size.height as f64 / sf,
            }
        })
        .collect()
}

pub(crate) fn open_note_window(app: &AppHandle, note: &Note) {
    let label = format!("note-{}", note.id);
    let url = format!("note.html?id={}", note.id);

    let (x, y) = clamp_to_screen(app, note.x, note.y);
    let win = match WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title("") // No title for Stickies-like feel
        .inner_size(note.width, note.height)
        .min_inner_size(200.0, 150.0)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .always_on_top(note.pinned)
        .accept_first_mouse(true)
        .visible(true)
        // Tauri の既定 drag-drop ハンドラは WKWebView 標準の HTML5 drag/drop を握りつぶし、
        // Finder / ブラウザからドラッグした画像が DataTransfer.files に届かなくなる。
        // 付箋ウィンドウだけ無効化し、ドロップは note.js 側の HTML5 API で処理する
        .disable_drag_drop_handler()
        .build()
    {
        Ok(win) => win,
        Err(e) => {
            log::error!("open note window error: note={} err={}", note.id, e);
            return;
        }
    };

    // Bring other notes to front when this window receives native focus.
    // Using WindowEvent::Focused is more reliable than JS focus events, as it
    // fires after macOS animations complete (e.g. Mission Control, app switching).
    let app_handle = app.clone();
    let note_id = note.id.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(true) = event {
            bring_others_to_front(&app_handle, &note_id);
        }
    });
}

/// Bring all other note windows to the front when one note receives focus.
/// Includes a 500ms cooldown to prevent cascading calls from programmatic set_focus().
fn bring_others_to_front(app: &AppHandle, caller_id: &str) {
    let state: State<AppState> = app.state();

    if !state.settings.recover().bring_all_to_front {
        return;
    }

    {
        let mut last = state.last_bring_to_front.recover();
        if last.elapsed() < std::time::Duration::from_millis(500) {
            return;
        }
        *last = Instant::now();
    }

    let ids: Vec<String> = {
        let notes = state.notes.recover();
        notes
            .iter()
            .filter(|n| n.id != caller_id)
            .map(|n| n.id.clone())
            .collect()
    };

    for id in &ids {
        if let Some(win) = app.get_webview_window(&format!("note-{}", id)) {
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
    // Re-focus the caller so it stays on top
    if let Some(win) = app.get_webview_window(&format!("note-{}", caller_id)) {
        let _ = win.set_focus();
    }
}

// ── Window Management (Settings) ────────────────────────────

const VALID_TABS: &[&str] = &["settings", "help"];

pub(crate) fn open_settings_window(app: &AppHandle, tab: Option<&str>) {
    let tab = tab.filter(|t| VALID_TABS.contains(t));
    if let Some(win) = app.get_webview_window("settings") {
        if let Some(t) = tab {
            let _ = win.emit("switch-tab", t);
        }
        let _ = win.set_focus();
        return;
    }
    let url = match tab {
        Some(t) => format!("settings.html?tab={}", t),
        None => "settings.html".to_string(),
    };
    let lang = i18n::resolve(app.state::<AppState>().settings.recover().language);
    match WebviewWindowBuilder::new(app, "settings", WebviewUrl::App(url.into()))
        .title(i18n::text(lang, Msg::SettingsWindowTitle))
        .inner_size(440.0, 600.0)
        .min_inner_size(380.0, 460.0)
        .resizable(true)
        .visible(true)
        .build()
    {
        Ok(win) => {
            // プレビューは設定画面の付属物なので、設定画面と一緒に閉じる
            let app_handle = app.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::Destroyed = event {
                    if let Some(preview) = app_handle.get_webview_window(NOTE_PREVIEW_LABEL) {
                        let _ = preview.close();
                    }
                }
            });
        }
        Err(e) => log::error!("open settings window error: {}", e),
    }
}

/// 設定画面で選んでいる見た目のプレビューに使うウィンドウのラベル。
/// `note-` で始めないので、付箋としては保存も基準選びもされない
pub(crate) const NOTE_PREVIEW_LABEL: &str = "settings-preview";

/// 付箋が `zoom`・`color`・`opacity` でどう見えるかを、付箋と同じ大きさのウィンドウで見せる。
/// 既に開いていれば中身だけ差し替える。位置は設定画面の左右（`preview_position`）。
/// `hold` が true の間（スライダーを操作中）は、プレビューはフェードアウトしない
pub(crate) fn show_note_preview(app: &AppHandle, zoom: u32, color: &str, opacity: u32, hold: bool) {
    let zoom = clamp_zoom(zoom);
    let opacity = clamp_opacity(opacity);
    // ランダムは開くたびに色が変わって見本にならないので、先頭の色で見せる
    let color = if is_valid_color_key(color) {
        color
    } else {
        COLOR_DEFS[0].key
    };
    if let Some(win) = app.get_webview_window(NOTE_PREVIEW_LABEL) {
        let _ = win.emit_to(
            NOTE_PREVIEW_LABEL,
            "note-preview-update",
            serde_json::json!({ "zoom": zoom, "color": color, "opacity": opacity, "hold": hold }),
        );
        return;
    }
    let windows = window_snapshots(app);
    let (x, y) = match windows.iter().find(|w| w.label == "settings") {
        Some(settings) => preview_position(
            &Anchor::new(settings, false),
            DEFAULT_SIZE,
            &work_area_rects(app),
        ),
        None => DEFAULT_POSITION,
    };
    let (x, y) = clamp_to_screen(app, x, y);
    let url = format!(
        "note.html?preview=1&zoom={zoom}&color={color}&opacity={opacity}&hold={}",
        u8::from(hold)
    );
    match WebviewWindowBuilder::new(app, NOTE_PREVIEW_LABEL, WebviewUrl::App(url.into()))
        .title("")
        .inner_size(DEFAULT_SIZE.0, DEFAULT_SIZE.1)
        .resizable(false)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        // 設定画面からフォーカスを奪わず、クリックも受けない。見るためだけのウィンドウ
        .focused(false)
        .visible(true)
        .build()
    {
        Ok(win) => {
            let _ = win.set_ignore_cursor_events(true);
        }
        Err(e) => log::error!("open note preview window error: {}", e),
    }
}

pub(crate) fn open_trash_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("trash") {
        let _ = win.set_focus();
        return;
    }
    let lang = i18n::resolve(app.state::<AppState>().settings.recover().language);
    if let Err(e) = WebviewWindowBuilder::new(app, "trash", WebviewUrl::App("trash.html".into()))
        .title(i18n::text(lang, Msg::TrashWindowTitle))
        .inner_size(360.0, 480.0)
        .min_inner_size(300.0, 300.0)
        .resizable(true)
        .visible(true)
        .build()
    {
        log::error!("open trash window error: {}", e);
    }
}

// ── Reopen Notes (Dock/Alfred Reopen, Single-Instance Relaunch) ──────

/// Show every note window, recreating any that were closed. If there are no
/// notes at all, create one so reopening the app is never a no-op.
pub(crate) fn reopen_notes(app: &AppHandle) {
    let state: State<AppState> = app.state();
    // Read the count into a binding so the lock is released before
    // create_note_with_window takes it again.
    let is_empty = state.notes.recover().is_empty();
    if is_empty {
        let note = create_note_with_window(app, &state, None);
        if let Some(win) = app.get_webview_window(&format!("note-{}", note.id)) {
            let _ = win.set_focus();
        }
        return;
    }
    let notes = state.notes.recover();
    for note in notes.iter() {
        if let Some(win) = app.get_webview_window(&format!("note-{}", note.id)) {
            let _ = win.show();
            let _ = win.set_focus();
        } else {
            // Window was closed (e.g. via ⌘W) — recreate it
            open_note_window(app, note);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn single_monitor() -> Vec<Rect> {
        vec![Rect {
            x: 0.0,
            y: 0.0,
            w: 1920.0,
            h: 1080.0,
        }]
    }

    #[test]
    fn inside_single_monitor() {
        assert_eq!(
            clamp_position(100.0, 200.0, &single_monitor(), (0.0, 0.0)),
            (100.0, 200.0)
        );
    }

    #[test]
    fn outside_single_monitor_resets_to_default() {
        assert_eq!(
            clamp_position(5000.0, 5000.0, &single_monitor(), (0.0, 0.0)),
            (DEFAULT_POSITION.0, DEFAULT_POSITION.1)
        );
    }

    #[test]
    fn negative_coords_outside_monitor() {
        assert_eq!(
            clamp_position(-100.0, -100.0, &single_monitor(), (0.0, 0.0)),
            (DEFAULT_POSITION.0, DEFAULT_POSITION.1)
        );
    }

    #[test]
    fn edge_margin_50px() {
        // At the very edge (within 50px margin) → should be clamped
        assert_eq!(
            clamp_position(1870.5, 1030.5, &single_monitor(), (0.0, 0.0)),
            (DEFAULT_POSITION.0, DEFAULT_POSITION.1)
        );
        // Just inside margin → should pass
        assert_eq!(
            clamp_position(1869.0, 1029.0, &single_monitor(), (0.0, 0.0)),
            (1869.0, 1029.0)
        );
    }

    #[test]
    fn dual_monitor_second_screen() {
        let monitors = vec![
            Rect {
                x: 0.0,
                y: 0.0,
                w: 1920.0,
                h: 1080.0,
            },
            Rect {
                x: 1920.0,
                y: 0.0,
                w: 2560.0,
                h: 1440.0,
            },
        ];
        // On second monitor
        assert_eq!(
            clamp_position(2000.0, 500.0, &monitors, (0.0, 0.0)),
            (2000.0, 500.0)
        );
    }

    #[test]
    fn outside_all_monitors_uses_primary_origin() {
        let monitors = vec![Rect {
            x: 0.0,
            y: 0.0,
            w: 1920.0,
            h: 1080.0,
        }];
        assert_eq!(
            clamp_position(9999.0, 9999.0, &monitors, (100.0, 50.0)),
            (100.0 + DEFAULT_POSITION.0, 50.0 + DEFAULT_POSITION.1)
        );
    }

    // ── New note placement ──

    const NOTE_SIZE: (f64, f64) = (280.0, 320.0);

    fn snapshot(label: &str, focused: bool, position: (i32, i32), sf: f64) -> WindowSnapshot {
        WindowSnapshot {
            label: label.to_string(),
            focused,
            position,
            size: ((NOTE_SIZE.0 * sf) as u32, (NOTE_SIZE.1 * sf) as u32),
            scale_factor: sf,
        }
    }

    fn picked<'a>(windows: &'a [WindowSnapshot], label: Option<&str>) -> Option<&'a str> {
        pick_anchor(windows, label).map(|w| w.label.as_str())
    }

    fn anchor(x: f64, y: f64, empty: bool) -> Anchor {
        Anchor {
            x,
            y,
            w: NOTE_SIZE.0,
            h: NOTE_SIZE.1,
            empty,
        }
    }

    fn dual_monitors() -> Vec<Rect> {
        vec![
            Rect {
                x: 0.0,
                y: 0.0,
                w: 1920.0,
                h: 1080.0,
            },
            Rect {
                x: 1920.0,
                y: 0.0,
                w: 2560.0,
                h: 1440.0,
            },
        ]
    }

    #[test]
    fn anchor_is_focused_note() {
        let windows = [
            snapshot("note-a", false, (100, 100), 1.0),
            snapshot("note-b", true, (1000, 600), 1.0),
        ];
        assert_eq!(picked(&windows, None), Some("note-b"));
    }

    #[test]
    fn anchor_is_converted_to_logical_coords() {
        let a = Anchor::new(&snapshot("note-a", true, (1000, 600), 2.0), false);
        assert_eq!(
            (a.x, a.y, a.w, a.h),
            (500.0, 300.0, NOTE_SIZE.0, NOTE_SIZE.1)
        );
    }

    #[test]
    fn anchor_ignores_focused_settings_and_trash() {
        let windows = [
            snapshot("settings", true, (0, 0), 1.0),
            snapshot("trash", true, (0, 0), 1.0),
            snapshot("note-a", false, (100, 100), 1.0),
        ];
        assert_eq!(picked(&windows, None), None);
    }

    #[test]
    fn explicit_anchor_wins_over_focused_note() {
        // Right-clicking an unfocused note doesn't make it key on macOS
        let windows = [
            snapshot("note-a", true, (100, 100), 1.0),
            snapshot("note-b", false, (800, 400), 1.0),
        ];
        assert_eq!(picked(&windows, Some("note-b")), Some("note-b"));
    }

    #[test]
    fn new_note_right_of_anchor_with_content() {
        let a = anchor(500.0, 300.0, false);
        assert_eq!(
            new_note_position(Some(&a), NOTE_SIZE, &dual_monitors(), &[], 3),
            (500.0 + NOTE_SIZE.0 + BESIDE_GAP, 300.0)
        );
    }

    #[test]
    fn new_note_left_of_anchor_at_right_edge() {
        let a = anchor(1920.0 - NOTE_SIZE.0, 300.0, false);
        assert_eq!(
            new_note_position(Some(&a), NOTE_SIZE, &single_monitor(), &[], 3),
            (a.x - NOTE_SIZE.0 - BESIDE_GAP, 300.0)
        );
    }

    #[test]
    fn new_note_below_anchor_when_no_room_on_either_side() {
        let a = Anchor {
            w: 1500.0,
            ..anchor(200.0, 300.0, false)
        };
        assert_eq!(
            new_note_position(Some(&a), NOTE_SIZE, &single_monitor(), &[], 3),
            (200.0, 300.0 + NOTE_SIZE.1 + BESIDE_GAP)
        );
    }

    #[test]
    fn new_note_beside_anchor_near_bottom_is_lifted_into_monitor() {
        let a = anchor(500.0, 1000.0, false);
        assert_eq!(
            new_note_position(Some(&a), NOTE_SIZE, &single_monitor(), &[], 3),
            (500.0 + NOTE_SIZE.0 + BESIDE_GAP, 1080.0 - NOTE_SIZE.1)
        );
    }

    fn note_at(x: f64, y: f64) -> Rect {
        Rect {
            x,
            y,
            w: NOTE_SIZE.0,
            h: NOTE_SIZE.1,
        }
    }

    const RIGHT_OF_800: f64 = 800.0 + NOTE_SIZE.0 + BESIDE_GAP;
    const LEFT_OF_800: f64 = 800.0 - NOTE_SIZE.0 - BESIDE_GAP;

    #[test]
    fn note_rects_excludes_settings_and_trash() {
        let windows = [
            snapshot("settings", true, (0, 0), 1.0),
            snapshot("note-a", false, (100, 200), 2.0),
        ];
        let rects = note_rects(&windows);
        assert_eq!(rects.len(), 1);
        assert_eq!((rects[0].x, rects[0].y), (50.0, 100.0));
    }

    #[test]
    fn anchor_is_empty_looks_up_note_by_window_label() {
        let mut written = Note::new("yellow");
        written.content = "todo".into();
        let mut blank = Note::new("yellow");
        blank.content = " \n".into();
        let label = |n: &Note| format!("note-{}", n.id);
        let notes = [written.clone(), blank.clone()];
        assert!(!anchor_is_empty(&notes, &label(&written)));
        assert!(anchor_is_empty(&notes, &label(&blank)));
        assert!(anchor_is_empty(&notes, "note-unknown"));
    }

    #[test]
    fn explicit_anchor_that_is_not_a_note_window_gives_no_anchor() {
        // Does not fall back to the focused note
        let windows = [
            snapshot("note-a", true, (100, 100), 1.0),
            snapshot("trash", false, (800, 400), 1.0),
        ];
        assert_eq!(picked(&windows, Some("trash")), None);
        assert_eq!(picked(&windows, Some("note-missing")), None);
    }

    #[test]
    fn new_note_from_empty_anchor_at_top_left_edge_stays_on_monitor() {
        // Anchor partly off the top-left corner
        let a = anchor(-50.0, -40.0, true);
        assert_eq!(
            new_note_position(Some(&a), NOTE_SIZE, &single_monitor(), &[], 3),
            (0.0, 0.0)
        );
    }

    #[test]
    fn new_note_skips_right_spot_taken_by_another_note() {
        let a = anchor(800.0, 300.0, false);
        let notes = [note_at(RIGHT_OF_800, 300.0)];
        assert_eq!(
            new_note_position(Some(&a), NOTE_SIZE, &single_monitor(), &notes, 3),
            (LEFT_OF_800, 300.0)
        );
    }

    /// 設定ウィンドウ（440×600）を基準にした Anchor
    fn settings_at(x: f64, y: f64) -> Anchor {
        Anchor {
            w: 440.0,
            h: 600.0,
            ..anchor(x, y, false)
        }
    }

    #[test]
    fn preview_goes_right_of_settings() {
        let a = settings_at(500.0, 200.0);
        assert_eq!(
            preview_position(&a, NOTE_SIZE, &single_monitor()),
            (500.0 + 440.0 + BESIDE_GAP, 200.0)
        );
    }

    #[test]
    fn preview_goes_left_when_right_does_not_fit() {
        let a = settings_at(1920.0 - 440.0, 200.0);
        assert_eq!(
            preview_position(&a, NOTE_SIZE, &single_monitor()),
            (a.x - NOTE_SIZE.0 - BESIDE_GAP, 200.0)
        );
    }

    #[test]
    fn preview_never_goes_below_and_covers_settings_when_neither_side_fits() {
        let a = Anchor {
            w: 1500.0,
            ..settings_at(200.0, 200.0)
        };
        // 新しい付箋なら下に出る配置でも、右端に寄せて設定ウィンドウに重ねる
        assert_eq!(
            preview_position(&a, NOTE_SIZE, &single_monitor()),
            (1920.0 - NOTE_SIZE.0, 200.0)
        );
    }

    #[test]
    fn preview_beside_settings_near_bottom_is_lifted_into_monitor() {
        let a = settings_at(500.0, 900.0);
        assert_eq!(
            preview_position(&a, NOTE_SIZE, &single_monitor()),
            (500.0 + 440.0 + BESIDE_GAP, 1080.0 - NOTE_SIZE.1)
        );
    }

    #[test]
    fn new_note_goes_below_when_both_sides_are_taken() {
        let a = anchor(800.0, 300.0, false);
        let notes = [note_at(RIGHT_OF_800, 300.0), note_at(LEFT_OF_800, 300.0)];
        assert_eq!(
            new_note_position(Some(&a), NOTE_SIZE, &single_monitor(), &notes, 3),
            (800.0, 300.0 + NOTE_SIZE.1 + BESIDE_GAP)
        );
    }

    #[test]
    fn new_note_goes_above_when_sides_are_taken_and_below_does_not_fit() {
        let a = anchor(800.0, 700.0, false);
        let notes = [note_at(RIGHT_OF_800, 700.0), note_at(LEFT_OF_800, 700.0)];
        assert_eq!(
            new_note_position(Some(&a), NOTE_SIZE, &single_monitor(), &notes, 3),
            (800.0, 700.0 - NOTE_SIZE.1 - BESIDE_GAP)
        );
    }

    #[test]
    fn new_note_covers_right_spot_when_every_spot_is_taken() {
        let a = anchor(800.0, 300.0, false);
        let notes = [
            note_at(RIGHT_OF_800, 300.0),
            note_at(LEFT_OF_800, 300.0),
            note_at(800.0, 300.0 + NOTE_SIZE.1 + BESIDE_GAP),
        ];
        assert_eq!(
            new_note_position(Some(&a), NOTE_SIZE, &single_monitor(), &notes, 3),
            (RIGHT_OF_800, 300.0)
        );
    }

    #[test]
    fn new_note_cascades_when_nothing_fits_beside_anchor() {
        let a = Anchor {
            w: 1900.0,
            h: 1000.0,
            ..anchor(0.0, 0.0, false)
        };
        assert_eq!(
            new_note_position(Some(&a), NOTE_SIZE, &single_monitor(), &[], 3),
            (CASCADE_STEP, CASCADE_STEP)
        );
    }

    #[test]
    fn new_note_cascades_from_empty_anchor() {
        // Lets the user line up many blank notes before writing them
        let a = anchor(500.0, 300.0, true);
        assert_eq!(
            new_note_position(Some(&a), NOTE_SIZE, &dual_monitors(), &[], 3),
            (500.0 + CASCADE_STEP, 300.0 + CASCADE_STEP)
        );
    }

    #[test]
    fn new_note_near_bottom_right_edge_stays_on_anchor_monitor() {
        let monitors = dual_monitors();
        // Empty anchor near the bottom-right corner of the second monitor
        let a = anchor(4300.0, 1300.0, true);
        let (x, y) = new_note_position(Some(&a), NOTE_SIZE, &monitors, &[], 3);
        assert_eq!(
            (x, y),
            (1920.0 + 2560.0 - NOTE_SIZE.0, 1440.0 - NOTE_SIZE.1)
        );
        // Must not be sent back to the default position by clamp_position
        assert_eq!(clamp_position(x, y, &monitors, (0.0, 0.0)), (x, y));
    }

    #[test]
    fn new_note_does_not_cover_anchor_at_bottom_right_limit() {
        // Anchor already pushed to the limit (e.g. after repeated ⌘N):
        // going down-right would land exactly on it, so go up-left instead
        let a = anchor(1920.0 + 2560.0 - NOTE_SIZE.0, 1440.0 - NOTE_SIZE.1, true);
        assert_eq!(
            new_note_position(Some(&a), NOTE_SIZE, &dual_monitors(), &[], 3),
            (a.x - CASCADE_STEP, a.y - CASCADE_STEP)
        );
    }

    #[test]
    fn new_note_with_anchor_off_left_edge_uses_nearest_monitor() {
        let monitors = dual_monitors();
        let a = anchor(-100.0, 300.0, false);
        let (x, y) = new_note_position(Some(&a), NOTE_SIZE, &monitors, &[], 3);
        assert_eq!((x, y), (-100.0 + NOTE_SIZE.0 + BESIDE_GAP, 300.0));
        assert_eq!(clamp_position(x, y, &monitors, (0.0, 0.0)), (x, y));
    }

    #[test]
    fn new_note_without_anchor_cascades_from_default() {
        assert_eq!(
            new_note_position(None, NOTE_SIZE, &dual_monitors(), &[], 2),
            (
                DEFAULT_POSITION.0 + 2.0 * CASCADE_STEP,
                DEFAULT_POSITION.1 + 2.0 * CASCADE_STEP
            )
        );
        // Wraps back to the default position every 20 notes
        assert_eq!(
            new_note_position(None, NOTE_SIZE, &dual_monitors(), &[], 20),
            DEFAULT_POSITION
        );
    }

    #[test]
    fn empty_monitors_returns_default() {
        assert_eq!(
            clamp_position(500.0, 500.0, &[], (0.0, 0.0)),
            (DEFAULT_POSITION.0, DEFAULT_POSITION.1)
        );
    }
}
