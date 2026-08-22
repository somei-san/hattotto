use tauri::image::Image;
use tauri::menu::{ContextMenu, IconMenuItem, Menu, MenuItem, NativeIcon, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::{confirm_delete_if_needed, do_delete_note};
use crate::i18n::{self, Lang, Msg};
use crate::model::{is_valid_color_key, AppState, RecoverMutex, COLOR_DEFS};
use crate::persistence::save_notes;
use crate::window::{create_note_with_window, open_settings_window, open_trash_window};

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
pub(crate) fn build_context_menu(
    app: &AppHandle,
    webview_win: &tauri::WebviewWindow,
    is_pinned: bool,
    current_color: &str,
    lang: Lang,
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
                format!("{}{}", check, i18n::color_label(lang, c.key)),
                true,
                Some(color_circle(c.r, c.g, c.b)),
                None::<&str>,
            )
        })
        .collect::<tauri::Result<Vec<_>>>()?;

    let copy = PredefinedMenuItem::copy(app, None)?;
    let paste = PredefinedMenuItem::paste(app, None)?;
    let sep0 = PredefinedMenuItem::separator(app)?;
    let pin_label = if is_pinned {
        Msg::CtxUnpin
    } else {
        Msg::CtxPin
    };
    let pin = MenuItem::with_id(
        app,
        "ctx_pin",
        i18n::text(lang, pin_label),
        true,
        None::<&str>,
    )?;
    let new_note = IconMenuItem::with_id_and_native_icon(
        app,
        "ctx_new",
        i18n::text(lang, Msg::NewNote),
        true,
        Some(NativeIcon::Add),
        Some("CmdOrCtrl+N"),
    )?;
    let delete = IconMenuItem::with_id_and_native_icon(
        app,
        "ctx_delete",
        i18n::text(lang, Msg::CtxDelete),
        true,
        Some(NativeIcon::Remove),
        None::<&str>,
    )?;
    let trash = IconMenuItem::with_id_and_native_icon(
        app,
        "ctx_trash",
        i18n::text(lang, Msg::CtxOpenTrash),
        true,
        Some(NativeIcon::TrashEmpty),
        Some("CmdOrCtrl+Shift+T"),
    )?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep1b = PredefinedMenuItem::separator(app)?;
    let zoom_in = MenuItem::with_id(
        app,
        "ctx_zoom_in",
        i18n::text(lang, Msg::ZoomIn),
        true,
        Some("CmdOrCtrl+="),
    )?;
    let zoom_out = MenuItem::with_id(
        app,
        "ctx_zoom_out",
        i18n::text(lang, Msg::ZoomOut),
        true,
        Some("CmdOrCtrl+-"),
    )?;
    let zoom_reset = MenuItem::with_id(
        app,
        "ctx_zoom_reset",
        i18n::text(lang, Msg::CtxZoomReset),
        true,
        Some("CmdOrCtrl+0"),
    )?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let settings = MenuItem::with_id(
        app,
        "ctx_settings",
        i18n::text(lang, Msg::CtxOpenSettings),
        true,
        Some("CmdOrCtrl+,"),
    )?;
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
                if let Err(e) = do_delete_note(&note_id, app, &state) {
                    eprintln!("delete note error: {}", e);
                }
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
            if !is_valid_color_key(color) {
                return;
            }
            let snapshot = {
                let mut notes = state.notes.recover();
                if let Some(note) = notes.iter_mut().find(|n| n.id == note_id) {
                    note.color = color.to_string();
                    Some(notes.clone())
                } else {
                    None
                }
            };
            if let Some(snap) = snapshot {
                if let Err(e) = save_notes(&state, &snap) {
                    eprintln!("save notes error: {}", e);
                }
            }
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
            assert!(is_valid_color_key(c.key));
        }
        // A bogus key must not pass
        assert!(!is_valid_color_key("bogus"));
    }
}
