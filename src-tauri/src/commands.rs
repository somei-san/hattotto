use std::time::Instant;

use tauri::image::Image;
use tauri::menu::{ContextMenu, IconMenuItem, Menu, MenuItem, NativeIcon, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

use crate::model::{AppState, Note, RecoverMutex, Settings, COLOR_DEFS, TRASH_MAX};
use crate::persistence::{enforce_trash_limit, save_notes, save_settings, save_trash};
use crate::window::{
    create_note_with_window, open_note_window, open_settings_window, open_trash_window,
};

// ── Tauri Commands ──────────────────────────────────────────

/// 指定 ID の付箋を返す。見つからない場合は `None`。
#[tauri::command]
pub(crate) fn get_note(id: String, state: State<AppState>) -> Option<Note> {
    let notes = state.notes.recover();
    notes.iter().find(|n| n.id == id).cloned()
}

/// 付箋の本文を更新して保存する。
#[tauri::command]
pub(crate) fn update_note_content(id: String, content: String, state: State<AppState>) {
    let mut notes = state.notes.recover();
    if let Some(note) = notes.iter_mut().find(|n| n.id == id) {
        note.content = content;
        save_notes(&notes);
    }
}

/// 付箋の色を更新して保存する。
#[tauri::command]
pub(crate) fn update_note_color(id: String, color: String, state: State<AppState>) {
    let mut notes = state.notes.recover();
    if let Some(note) = notes.iter_mut().find(|n| n.id == id) {
        note.color = color;
        save_notes(&notes);
    }
}

/// 付箋のウィンドウ位置・サイズを更新して保存する。
#[tauri::command]
pub(crate) fn update_note_geometry(
    id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    state: State<AppState>,
) {
    let mut notes = state.notes.recover();
    if let Some(note) = notes.iter_mut().find(|n| n.id == id) {
        note.x = x;
        note.y = y;
        note.width = width;
        note.height = height;
        save_notes(&notes);
    }
}

/// 付箋の表示倍率（50〜200%）を更新して保存する。
#[tauri::command]
pub(crate) fn update_note_zoom(id: String, zoom: u32, state: State<AppState>) {
    let mut notes = state.notes.recover();
    if let Some(note) = notes.iter_mut().find(|n| n.id == id) {
        note.zoom = zoom.clamp(50, 200);
        save_notes(&notes);
    }
}

/// 付箋のピン留め状態を更新して保存する。
#[tauri::command]
pub(crate) fn update_note_pinned(id: String, pinned: bool, state: State<AppState>) {
    let mut notes = state.notes.recover();
    if let Some(note) = notes.iter_mut().find(|n| n.id == id) {
        note.pinned = pinned;
        save_notes(&notes);
    }
}

/// Confirm deletion if setting is enabled. Returns false if user cancelled.
pub(crate) fn confirm_delete_if_needed(app: &AppHandle, state: &AppState) -> bool {
    let confirm = state.settings.recover().confirm_before_delete;
    if !confirm {
        return true;
    }
    app.dialog()
        .message("この付箋を削除しますか？")
        .title("貼っとーと")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "削除".into(),
            "キャンセル".into(),
        ))
        .blocking_show()
}

/// Move a note to trash and close its window.
pub(crate) fn do_delete_note(id: &str, app: &AppHandle, state: &AppState) {
    {
        let mut notes = state.notes.recover();
        if let Some(pos) = notes.iter().position(|n| n.id == id) {
            let note = notes.remove(pos);
            save_notes(&notes);
            let mut trash = state.trash.recover();
            trash.push(note);
            enforce_trash_limit(&mut trash);
            save_trash(&trash);
        }
    }
    if let Some(win) = app.get_webview_window(&format!("note-{}", id)) {
        let _ = win.close();
    }
}

/// 付箋をゴミ箱へ移動する。`confirm_before_delete` が有効な場合は確認ダイアログを表示する。
#[tauri::command]
pub(crate) fn delete_note(id: String, app: AppHandle, state: State<AppState>) {
    if !confirm_delete_if_needed(&app, &state) {
        return;
    }
    do_delete_note(&id, &app, &state);
}

/// ゴミ箱内の付箋一覧を返す。
#[tauri::command]
pub(crate) fn get_trash(state: State<AppState>) -> Vec<Note> {
    state.trash.recover().clone()
}

/// ゴミ箱の最大保存件数を返す。
#[tauri::command]
pub(crate) fn get_trash_max() -> usize {
    TRASH_MAX
}

/// ゴミ箱から付箋を復元し、ウィンドウを開く。見つからない場合は `None`。
#[tauri::command]
pub(crate) fn restore_note(id: String, app: AppHandle, state: State<AppState>) -> Option<Note> {
    let note = {
        let mut trash = state.trash.recover();
        if let Some(pos) = trash.iter().position(|n| n.id == id) {
            let note = trash.remove(pos);
            save_trash(&trash);
            Some(note)
        } else {
            None
        }
    };
    if let Some(note) = note {
        open_note_window(&app, &note);
        let mut notes = state.notes.recover();
        notes.push(note.clone());
        save_notes(&notes);
        Some(note)
    } else {
        None
    }
}

/// ゴミ箱を空にする。
#[tauri::command]
pub(crate) fn empty_trash(state: State<AppState>) {
    let mut trash = state.trash.recover();
    trash.clear();
    save_trash(&trash);
}

/// 現在の設定を返す。
#[tauri::command]
pub(crate) fn get_settings(state: State<AppState>) -> Settings {
    state.settings.recover().clone()
}

/// 設定を更新して保存する。数値は範囲内にクランプされる。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn update_settings(
    default_color: String,
    font_size: u32,
    zoom: u32,
    opacity: u32,
    edit_on_single_click: bool,
    bring_all_to_front: bool,
    show_pin_button: bool,
    show_new_button: bool,
    show_color_button: bool,
    confirm_before_delete: bool,
    state: State<AppState>,
) {
    let mut settings = state.settings.recover();
    settings.default_color = default_color;
    settings.font_size = font_size.clamp(8, 72);
    settings.zoom = zoom.clamp(50, 200);
    settings.opacity = opacity.clamp(20, 100);
    settings.edit_on_single_click = edit_on_single_click;
    settings.bring_all_to_front = bring_all_to_front;
    settings.show_pin_button = show_pin_button;
    settings.show_new_button = show_new_button;
    settings.show_color_button = show_color_button;
    settings.confirm_before_delete = confirm_before_delete;
    save_settings(&settings);
}

/// 設定ウィンドウを開く（既に開いている場合はフォーカスを移す）。
#[tauri::command]
pub(crate) fn open_settings(app: AppHandle) {
    open_settings_window(&app, None);
}

/// ゴミ箱ウィンドウを開く（既に開いている場合はフォーカスを移す）。
#[tauri::command]
pub(crate) fn open_trash(app: AppHandle) {
    open_trash_window(&app);
}

/// 新しい付箋を作成してウィンドウを開き、作成した付箋を返す。
#[tauri::command]
pub(crate) fn create_note(app: AppHandle, state: State<AppState>) -> Note {
    create_note_with_window(&app, &state)
}

/// 呼び出し元以外の全付箋ウィンドウを前面に表示する（500ms クールダウン付き）。
#[tauri::command]
pub(crate) fn bring_other_notes_to_front(
    caller_id: String,
    app: AppHandle,
    state: State<AppState>,
) {
    // Cooldown: skip if triggered within last 1 second
    {
        let mut last = state.last_bring_to_front.recover();
        if last.elapsed() < std::time::Duration::from_millis(500) {
            return;
        }
        *last = Instant::now();
    }
    // Clone IDs only, release lock before window operations to avoid deadlock
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

/// Generate a colored circle icon (16×16 RGBA) for context menu color items.
fn color_circle(r: u8, g: u8, b: u8) -> Image<'static> {
    const S: u32 = 16;
    let mut rgba = vec![0u8; (S * S * 4) as usize];
    let c = S as f32 / 2.0;
    let rad = c - 1.0;
    for y in 0..S {
        for x in 0..S {
            let d = ((x as f32 - c).powi(2) + (y as f32 - c).powi(2)).sqrt();
            let i = ((y * S + x) * 4) as usize;
            if d <= rad {
                rgba[i] = r;
                rgba[i + 1] = g;
                rgba[i + 2] = b;
                rgba[i + 3] = 255;
            }
        }
    }
    Image::new_owned(rgba, S, S)
}

/// Build and display the note context menu. Returns Err on menu construction failure.
fn build_context_menu(
    app: &AppHandle,
    webview_win: &tauri::WebviewWindow,
    is_pinned: bool,
    current_color: &str,
) -> tauri::Result<()> {
    let color_items: Vec<IconMenuItem<tauri::Wry>> = COLOR_DEFS
        .iter()
        .map(|c| {
            let check = if c.key == current_color {
                "✓ "
            } else {
                "    "
            };
            IconMenuItem::with_id(
                app,
                format!("ctx_color_{}", c.key),
                format!("{}{}", check, c.label),
                true,
                Some(color_circle(c.r, c.g, c.b)),
                None::<&str>,
            )
            .unwrap()
        })
        .collect();

    let copy = PredefinedMenuItem::copy(app, None)?;
    let paste = PredefinedMenuItem::paste(app, None)?;
    let sep0 = PredefinedMenuItem::separator(app)?;
    let pin_label = if is_pinned {
        "ピン留め解除"
    } else {
        "ピン留め"
    };
    let pin = MenuItem::with_id(app, "ctx_pin", pin_label, true, None::<&str>)?;
    let new_note = IconMenuItem::with_id_and_native_icon(
        app,
        "ctx_new",
        "新しい付箋を作成",
        true,
        Some(NativeIcon::Add),
        Some("CmdOrCtrl+N"),
    )?;
    let delete = IconMenuItem::with_id_and_native_icon(
        app,
        "ctx_delete",
        "この付箋を削除",
        true,
        Some(NativeIcon::Remove),
        None::<&str>,
    )?;
    let trash = IconMenuItem::with_id_and_native_icon(
        app,
        "ctx_trash",
        "ゴミ箱を開く",
        true,
        Some(NativeIcon::TrashEmpty),
        Some("CmdOrCtrl+Shift+T"),
    )?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep1b = PredefinedMenuItem::separator(app)?;
    let zoom_in = MenuItem::with_id(app, "ctx_zoom_in", "ズームイン", true, Some("CmdOrCtrl+="))?;
    let zoom_out = MenuItem::with_id(
        app,
        "ctx_zoom_out",
        "ズームアウト",
        true,
        Some("CmdOrCtrl+-"),
    )?;
    let zoom_reset = MenuItem::with_id(
        app,
        "ctx_zoom_reset",
        "ズームリセット",
        true,
        Some("CmdOrCtrl+0"),
    )?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let settings = MenuItem::with_id(app, "ctx_settings", "設定を開く", true, Some("CmdOrCtrl+,"))?;
    let sep3 = PredefinedMenuItem::separator(app)?;

    let mut items: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = vec![
        &copy,
        &paste,
        &sep0,
        &pin,
        &sep1,
        &new_note,
        &delete,
        &trash,
        &sep1b,
        &zoom_in,
        &zoom_out,
        &zoom_reset,
        &sep2,
        &settings,
        &sep3,
    ];
    for ci in &color_items {
        items.push(ci as &dyn tauri::menu::IsMenuItem<tauri::Wry>);
    }

    let menu = Menu::with_items(app, &items)?;
    // popup() is blocking — shows native menu and returns after user selects or dismisses
    menu.popup(webview_win.as_ref().window().clone())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn show_context_menu(
    id: String,
    is_pinned: bool,
    current_color: String,
    app: AppHandle,
    state: State<AppState>,
) {
    let window_label = format!("note-{}", id);
    let Some(webview_win) = app.get_webview_window(&window_label) else {
        return;
    };

    // Store note ID so on_menu_event knows which note to target
    *state.context_menu_note_id.recover() = id;

    if let Err(e) = build_context_menu(&app, &webview_win, is_pinned, &current_color) {
        eprintln!("context menu error: {}", e);
    }
}

/// Handle context menu events (called from menu.rs on_menu_event)
pub(crate) fn handle_context_menu_event(app: &AppHandle, event_id: &str) {
    let state: State<AppState> = app.state();
    let note_id = state.context_menu_note_id.recover().clone();
    if note_id.is_empty() {
        return;
    }
    let win_label = format!("note-{}", note_id);

    let win = app.get_webview_window(&win_label);

    match event_id {
        "ctx_pin" => {
            if let Some(w) = &win {
                let _ = w.emit_to(w.label(), "ctx-toggle-pin", ());
            }
        }
        "ctx_new" => {
            create_note_with_window(app, &state);
        }
        "ctx_delete" => {
            if confirm_delete_if_needed(app, &state) {
                do_delete_note(&note_id, app, &state);
            }
        }
        "ctx_trash" => {
            open_trash_window(app);
        }
        "ctx_settings" => {
            open_settings_window(app, None);
        }
        "ctx_zoom_in" => {
            if let Some(w) = &win {
                let _ = w.emit_to(w.label(), "ctx-zoom", "in");
            }
        }
        "ctx_zoom_out" => {
            if let Some(w) = &win {
                let _ = w.emit_to(w.label(), "ctx-zoom", "out");
            }
        }
        "ctx_zoom_reset" => {
            if let Some(w) = &win {
                let _ = w.emit_to(w.label(), "ctx-zoom", "reset");
            }
        }
        _ if event_id.starts_with("ctx_color_") => {
            let color = event_id.trim_start_matches("ctx_color_");
            if !COLOR_DEFS.iter().any(|c| c.key == color) {
                return;
            }
            let mut notes = state.notes.recover();
            if let Some(note) = notes.iter_mut().find(|n| n.id == note_id) {
                note.color = color.to_string();
                save_notes(&notes);
            }
            drop(notes);
            if let Some(w) = &win {
                let _ = w.emit_to(w.label(), "ctx-apply-color", color);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── color_circle ────────────────────────────────────────

    #[test]
    fn color_circle_is_16x16() {
        let img = color_circle(255, 0, 0);
        assert_eq!(img.width(), 16);
        assert_eq!(img.height(), 16);
    }

    #[test]
    fn color_circle_center_is_opaque() {
        let img = color_circle(255, 128, 0);
        // Center pixel at (7, 7)
        let i = (7 * 16 + 7) * 4;
        let rgba = img.rgba();
        assert_eq!(rgba[i], 255); // R
        assert_eq!(rgba[i + 1], 128); // G
        assert_eq!(rgba[i + 2], 0); // B
        assert_eq!(rgba[i + 3], 255); // A = fully opaque
    }

    #[test]
    fn color_circle_corner_is_transparent() {
        let img = color_circle(255, 0, 0);
        // Corner pixel at (0, 0) is outside the circle
        let rgba = img.rgba();
        assert_eq!(rgba[3], 0); // A = transparent
    }

    // ── COLOR_DEFS validation ────────────────────────────────

    #[test]
    fn color_defs_keys_are_unique() {
        let keys: Vec<&str> = COLOR_DEFS.iter().map(|c| c.key).collect();
        let mut sorted = keys.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), keys.len(), "COLOR_DEFS has duplicate keys");
    }

    #[test]
    fn color_defs_matches_valid_color_check() {
        // All keys in COLOR_DEFS must pass the validation used in handle_context_menu_event
        for c in COLOR_DEFS {
            assert!(COLOR_DEFS.iter().any(|d| d.key == c.key));
        }
        // A bogus key must not pass
        assert!(!COLOR_DEFS.iter().any(|c| c.key == "bogus"));
    }
}
