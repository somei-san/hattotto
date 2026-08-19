mod commands;
mod i18n;
mod menu;
pub mod model;
mod persistence;
mod tray;
mod window;

use std::sync::Mutex;
use std::time::Instant;

use tauri::{Manager, State};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_shell::ShellExt;

use i18n::{Lang, Msg};
use model::{resolve_color, AppState, Note, Settings};
use persistence::{load_notes, load_settings, load_trash, save_notes, Loaded};
use window::{bring_all_to_front, open_note_window};

// ── App Entry ───────────────────────────────────────────────

pub fn run() {
    let (notes, notes_loaded) = match load_notes() {
        Loaded::Missing => (Vec::new(), true),
        Loaded::Ok(v) => (v, true),
        Loaded::Unreadable => (Vec::new(), false),
    };
    let (settings, settings_loaded) = match load_settings() {
        Loaded::Missing => (Settings::default(), true),
        Loaded::Ok(v) => (v, true),
        Loaded::Unreadable => (Settings::default(), false),
    };
    let (trash, trash_loaded) = match load_trash() {
        Loaded::Missing => (Vec::new(), true),
        Loaded::Ok(v) => (v, true),
        Loaded::Unreadable => (Vec::new(), false),
    };
    let state = AppState {
        notes: Mutex::new(notes),
        settings: Mutex::new(settings),
        trash: Mutex::new(trash),
        last_bring_to_front: Mutex::new(Instant::now() - std::time::Duration::from_secs(10)),
        context_menu_note_id: Mutex::new(String::new()),
        notes_loaded,
        settings_loaded,
        trash_loaded,
    };

    tauri::Builder::default()
        // 2 個目のインスタンスは同じ notes.json を別々に書き戻して互いの変更を消すため、
        // 起動そのものを止める。データディレクトリに触る前に終了させる必要があるので、
        // このプラグインは他より先に登録する
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            bring_all_to_front(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
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
            commands::get_trash_max,
            commands::restore_note,
            commands::empty_trash,
            commands::open_trash,
            commands::show_context_menu,
        ])
        .setup(|app| {
            // Set up app menu and system tray
            if let Err(e) = menu::setup_app_menu(app.handle()) {
                eprintln!("Failed to setup app menu: {e}");
            }
            if let Err(e) = tray::setup_tray(app.handle()) {
                eprintln!("Failed to setup tray: {e}");
            }

            let state: State<AppState> = app.state();

            // データファイルが読めなかった場合、付箋ウィンドウを開く前に伝える。
            // 「消えていない」ことが最重要なので、ウェルカム付箋の作成より先に知らせる。
            if !state.notes_loaded || !state.settings_loaded || !state.trash_loaded {
                let lang = i18n::resolve(
                    state
                        .settings
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .language,
                );
                let open_folder = app
                    .dialog()
                    .message(i18n::text(lang, Msg::DataLoadFailed))
                    .title(i18n::app_name(lang))
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        i18n::text(lang, Msg::DataLoadFailedOpenFolder).to_string(),
                        // 「OK」は日英で同一表記なのでリテラルで書く
                        "OK".to_string(),
                    ))
                    .blocking_show();

                if open_folder {
                    let dir = persistence::data_dir();
                    // tauri-plugin-opener は依存に無いため、既存の tauri_plugin_shell 経由で開く
                    #[allow(deprecated)]
                    let result = app.shell().open(dir.to_string_lossy(), None);
                    if let Err(e) = result {
                        eprintln!("Failed to open data folder: {e}");
                    }
                }
            }

            // Restore saved notes
            let notes = state
                .notes
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();

            if notes.is_empty() && state.notes_loaded {
                // Create default notes on first launch — one in Japanese, one in
                // English, so a first-time user sees both regardless of OS locale.
                drop(notes);
                let default_color = state
                    .settings
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .default_color
                    .clone();
                let color = resolve_color(&default_color);

                let mut note_ja = Note::new(&color);
                note_ja.content = String::from(i18n::welcome_note(Lang::Ja));

                let mut note_en = Note::new(&color);
                note_en.content = String::from(i18n::welcome_note(Lang::En));
                note_en.x += note_en.width + 20.0;

                open_note_window(app.handle(), &note_ja);
                open_note_window(app.handle(), &note_en);
                let mut notes = state.notes.lock().unwrap_or_else(|e| e.into_inner());
                notes.push(note_ja);
                notes.push(note_en);
                if let Err(e) = save_notes(&state, &notes) {
                    eprintln!("save notes error: {}", e);
                }
            } else {
                for note in &notes {
                    open_note_window(app.handle(), note);
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Hattotto")
        .run(|app, event| {
            if let tauri::RunEvent::Reopen { .. } = event {
                bring_all_to_front(app);
            }
        });
}
