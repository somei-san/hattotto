use tauri::{
    menu::{IconMenuItem, Menu, MenuItem, NativeIcon, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Manager, State,
};

use crate::commands::{confirm_delete_if_needed, do_delete_note};
use crate::model::AppState;
use crate::window::{create_note_with_window, open_settings_window, open_trash_window};

// ── App Menu ────────────────────────────────────────────────

pub(crate) fn setup_app_menu(app: &AppHandle) -> tauri::Result<()> {
    let settings_item = MenuItem::with_id(
        app,
        "open_settings",
        "Settings...",
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let new_note_item = IconMenuItem::with_id_and_native_icon(
        app,
        "new_note",
        "New Note",
        true,
        Some(NativeIcon::Add),
        Some("CmdOrCtrl+N"),
    )?;

    let app_submenu = Submenu::with_items(
        app,
        "貼っとーと",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &settings_item,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let trash_item = IconMenuItem::with_id_and_native_icon(
        app,
        "open_trash",
        "Trash...",
        true,
        Some(NativeIcon::TrashEmpty),
        Some("CmdOrCtrl+Shift+T"),
    )?;

    let file_submenu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &new_note_item,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "close_window", "Close Window", true, Some("CmdOrCtrl+W"))?,
            &PredefinedMenuItem::separator(app)?,
            &trash_item,
        ],
    )?;

    let edit_submenu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let zoom_in_item = MenuItem::with_id(app, "zoom_in", "Zoom In", true, Some("CmdOrCtrl+="))?;
    let zoom_out_item = MenuItem::with_id(app, "zoom_out", "Zoom Out", true, Some("CmdOrCtrl+-"))?;
    let zoom_reset_item =
        MenuItem::with_id(app, "zoom_reset", "Actual Size", true, Some("CmdOrCtrl+0"))?;
    let view_submenu = Submenu::with_items(
        app,
        "View",
        true,
        &[&zoom_in_item, &zoom_out_item, &zoom_reset_item],
    )?;

    let help_item = MenuItem::with_id(app, "open_help", "Hatto-to Help", true, None::<&str>)?;
    let help_submenu = Submenu::with_items(app, "Help", true, &[&help_item])?;

    let menu = Menu::with_items(
        app,
        &[
            &app_submenu,
            &file_submenu,
            &edit_submenu,
            &view_submenu,
            &help_submenu,
        ],
    )?;
    app.set_menu(menu)?;

    app.on_menu_event(|app, event| {
        let eid = event.id();
        let eid_str = eid.as_ref();
        // Context menu events (ctx_ prefix)
        if eid_str.starts_with("ctx_") {
            crate::commands::handle_context_menu_event(app, eid_str);
            return;
        }
        match eid_str {
            "close_window" => {
                if let Some(win) = app.get_focused_window() {
                    let label = win.label().to_string();
                    if let Some(note_id) = label.strip_prefix("note-") {
                        let state: State<AppState> = app.state();
                        if confirm_delete_if_needed(app, &state) {
                            do_delete_note(note_id, app, &state);
                        }
                    } else {
                        let _ = win.close();
                    }
                }
            }
            "open_settings" => {
                open_settings_window(app, None);
            }
            "new_note" => {
                let state: State<AppState> = app.state();
                create_note_with_window(app, &state);
            }
            "open_trash" => {
                open_trash_window(app);
            }
            "zoom_in" => {
                let _ = app.emit("zoom", "in");
            }
            "zoom_out" => {
                let _ = app.emit("zoom", "out");
            }
            "zoom_reset" => {
                let _ = app.emit("zoom", "reset");
            }
            "open_help" => {
                open_settings_window(app, Some("help"));
            }
            _ => {}
        }
    });

    Ok(())
}
