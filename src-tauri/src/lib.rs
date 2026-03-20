mod commands;
mod menu;
pub mod model;
mod persistence;
mod tray;
mod window;

use std::sync::Mutex;
use std::time::Instant;

use tauri::{Manager, State};
use tauri_plugin_autostart::MacosLauncher;

use model::{AppState, Note};
use persistence::{load_notes, load_settings, load_trash, save_notes};
use window::{bring_all_to_front, open_note_window};

// ── App Entry ───────────────────────────────────────────────

pub fn run() {
    let notes = load_notes();
    let settings = load_settings();
    let trash = load_trash();
    let state = AppState {
        notes: Mutex::new(notes),
        settings: Mutex::new(settings),
        trash: Mutex::new(trash),
        last_bring_to_front: Mutex::new(Instant::now() - std::time::Duration::from_secs(10)),
        context_menu_note_id: Mutex::new(String::new()),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_shell::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::get_note,
            commands::update_note_content,
            commands::update_note_color,
            commands::update_note_geometry,
            commands::update_note_zoom,
            commands::update_note_pinned,
            commands::delete_note,
            commands::create_note,
            commands::get_settings,
            commands::update_settings,
            commands::open_settings,
            commands::get_trash,
            commands::restore_note,
            commands::empty_trash,
            commands::open_trash,
            commands::bring_other_notes_to_front,
            commands::show_context_menu,
        ])
        .setup(|app| {
            // Set up app menu and system tray
            let _ = menu::setup_app_menu(app.handle());
            let _ = tray::setup_tray(app.handle());

            // Restore saved notes
            let state: State<AppState> = app.state();
            let notes = state.notes.lock().unwrap_or_else(|e| e.into_inner()).clone();

            if notes.is_empty() {
                // Create a default note on first launch
                drop(notes);
                let default_color = state.settings.lock().unwrap_or_else(|e| e.into_inner()).default_color.clone();
                let mut note = Note::new(&default_color);
                note.content = String::from("# Hatto-toへようこそ！\n\n- ダブルクリックで編集、外クリックでプレビュー\n- **太字** や *斜体* が使えます\n- [x] チェックボックスも\n- [ ] クリックで切替\n\n> 右クリックでメニュー、⌘N で新しい付箋");
                open_note_window(app.handle(), &note);
                let mut notes = state.notes.lock().unwrap_or_else(|e| e.into_inner());
                notes.push(note);
                save_notes(&notes);
            } else {
                for note in &notes {
                    open_note_window(app.handle(), note);
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Hatto-to")
        .run(|app, event| {
            if let tauri::RunEvent::Reopen { .. } = event {
                bring_all_to_front(app);
            }
        });
}
