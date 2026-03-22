use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, State,
};

use crate::model::AppState;
use crate::window::{create_note_with_window, open_settings_window};

// ── System Tray ─────────────────────────────────────────────

pub(crate) fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let new_note = MenuItem::with_id(app, "tray_new_note", "New Note", true, None::<&str>)?;
    let settings = MenuItem::with_id(
        app,
        "settings",
        "Settings / Help",
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, Some("CmdOrCtrl+Q"))?;
    let menu = Menu::with_items(app, &[&new_note, &settings, &quit])?;

    let icon = tauri::include_image!("icons/tray.png");

    TrayIconBuilder::new()
        .icon(icon)
        .icon_as_template(true)
        .menu(&menu)
        .tooltip("貼っとっと")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray_new_note" => {
                let state: State<AppState> = app.state();
                create_note_with_window(app, &state);
            }
            "settings" => {
                open_settings_window(app, None);
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}
