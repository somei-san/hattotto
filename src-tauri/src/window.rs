use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::model::{AppState, Note};
use crate::persistence::save_notes;

// ── Note Creation Helper ────────────────────────────────────

/// Create a new note with offset positioning and open its window.
/// Shared by create_note command, app menu, and tray menu.
pub(crate) fn create_note_with_window(app: &AppHandle, state: &AppState) -> Note {
    let default_color = state
        .settings
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .default_color
        .clone();
    let note = Note::new(&default_color);
    let mut notes = state.notes.lock().unwrap_or_else(|e| e.into_inner());
    let offset = ((notes.len() % 20) as f64) * 30.0;
    let mut n = note;
    n.x += offset;
    n.y += offset;
    open_note_window(app, &n);
    notes.push(n.clone());
    save_notes(&notes);
    n
}

// ── Window Management ───────────────────────────────────────

pub(crate) fn open_note_window(app: &AppHandle, note: &Note) {
    let label = format!("note-{}", note.id);
    let url = format!("note.html?id={}", note.id);

    let _ = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title("") // No title for Stickies-like feel
        .inner_size(note.width, note.height)
        .min_inner_size(200.0, 150.0)
        .position(note.x, note.y)
        .decorations(false)
        .transparent(true)
        .always_on_top(note.pinned)
        .accept_first_mouse(true)
        .visible(true)
        .build();
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
        .title("貼っとーと — 設定 / ヘルプ")
        .inner_size(420.0, 520.0)
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
    let notes = state.notes.lock().unwrap_or_else(|e| e.into_inner());
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
