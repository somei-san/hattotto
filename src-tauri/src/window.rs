use std::time::Instant;

use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::model::{resolve_color, AppState, Note, RecoverMutex};
use crate::persistence::save_notes;

const DEFAULT_POSITION: (f64, f64) = (120.0, 120.0);

// ── Monitor geometry (pure functions for testability) ────────

/// Logical bounds of a monitor: (x, y, width, height).
pub(crate) struct MonitorRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Check if (x, y) is inside any monitor (with 50px margin).
/// Returns the original coordinates if inside, or default position
/// offset from `primary_origin` if outside all monitors.
pub(crate) fn clamp_position(
    x: f64,
    y: f64,
    monitors: &[MonitorRect],
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

/// Create a new note with offset positioning and open its window.
/// Shared by create_note command, app menu, and tray menu.
pub(crate) fn create_note_with_window(app: &AppHandle, state: &AppState) -> Note {
    let default_color = state.settings.recover().default_color.clone();
    let color = resolve_color(&default_color);
    // Build note with offset — release notes lock before opening window
    let n = {
        let notes = state.notes.recover();
        let offset = ((notes.len() % 20) as f64) * 30.0;
        let mut n = Note::new(&color);
        n.x += offset;
        n.y += offset;
        n
    };
    open_note_window(app, &n);
    let snapshot = {
        let mut notes = state.notes.recover();
        notes.push(n.clone());
        notes.clone()
    };
    if let Err(e) = save_notes(&snapshot) {
        eprintln!("save notes error: {}", e);
    }
    n
}

// ── Window Management ───────────────────────────────────────

/// モニターの論理座標範囲を確認し、付箋の位置が全モニター外なら
/// プライマリモニター上のデフォルト位置にクランプする。
/// モニター情報が取得できない場合は検証不能なので元の座標をそのまま返す。
fn clamp_to_screen(app: &AppHandle, x: f64, y: f64) -> (f64, f64) {
    let Ok(monitors) = app.available_monitors() else {
        return (x, y);
    };
    if monitors.is_empty() {
        return (x, y);
    }
    let rects: Vec<MonitorRect> = monitors
        .iter()
        .map(|m| {
            let sf = m.scale_factor();
            MonitorRect {
                x: m.position().x as f64 / sf,
                y: m.position().y as f64 / sf,
                w: m.size().width as f64 / sf,
                h: m.size().height as f64 / sf,
            }
        })
        .collect();
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

pub(crate) fn open_note_window(app: &AppHandle, note: &Note) {
    let label = format!("note-{}", note.id);
    let url = format!("note.html?id={}", note.id);

    let (x, y) = clamp_to_screen(app, note.x, note.y);
    let Ok(win) = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title("") // No title for Stickies-like feel
        .inner_size(note.width, note.height)
        .min_inner_size(200.0, 150.0)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .always_on_top(note.pinned)
        .accept_first_mouse(true)
        .visible(true)
        .build()
    else {
        return;
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
    let _ = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App(url.into()))
        .title("貼っとっと — 設定 / ヘルプ")
        .inner_size(440.0, 600.0)
        .min_inner_size(380.0, 460.0)
        .resizable(true)
        .visible(true)
        .build();
}

pub(crate) fn open_trash_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("trash") {
        let _ = win.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "trash", WebviewUrl::App("trash.html".into()))
        .title("ゴミ箱")
        .inner_size(360.0, 480.0)
        .min_inner_size(300.0, 300.0)
        .resizable(true)
        .visible(true)
        .build();
}

// ── Bring All Notes to Front ────────────────────────────────

pub(crate) fn bring_all_to_front(app: &AppHandle) {
    let state: State<AppState> = app.state();
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

    fn single_monitor() -> Vec<MonitorRect> {
        vec![MonitorRect { x: 0.0, y: 0.0, w: 1920.0, h: 1080.0 }]
    }

    #[test]
    fn inside_single_monitor() {
        assert_eq!(clamp_position(100.0, 200.0, &single_monitor(), (0.0, 0.0)), (100.0, 200.0));
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
        assert_eq!(clamp_position(1869.0, 1029.0, &single_monitor(), (0.0, 0.0)), (1869.0, 1029.0));
    }

    #[test]
    fn dual_monitor_second_screen() {
        let monitors = vec![
            MonitorRect { x: 0.0, y: 0.0, w: 1920.0, h: 1080.0 },
            MonitorRect { x: 1920.0, y: 0.0, w: 2560.0, h: 1440.0 },
        ];
        // On second monitor
        assert_eq!(clamp_position(2000.0, 500.0, &monitors, (0.0, 0.0)), (2000.0, 500.0));
    }

    #[test]
    fn outside_all_monitors_uses_primary_origin() {
        let monitors = vec![
            MonitorRect { x: 0.0, y: 0.0, w: 1920.0, h: 1080.0 },
        ];
        assert_eq!(
            clamp_position(9999.0, 9999.0, &monitors, (100.0, 50.0)),
            (100.0 + DEFAULT_POSITION.0, 50.0 + DEFAULT_POSITION.1)
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
