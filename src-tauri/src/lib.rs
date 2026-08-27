mod commands;
mod context_menu;
mod i18n;
mod image_actions;
mod macos_prefs;
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
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

use i18n::{Lang, Msg};
use model::{resolve_color, AppState, Note, RecoverMutex, Settings};
use persistence::{load_notes, load_settings, load_trash, save_notes, Loaded};
use window::{bring_all_to_front, open_note_window};

// ── App Entry ───────────────────────────────────────────────

pub fn run() {
    macos_prefs::disable_press_and_hold();

    let data_dir = persistence::data_dir();
    // `notes_source_ok` / `trash_source_ok` は「実ファイルから読めた（Loaded::Ok）」かどうか。
    // `notes_loaded` 等（Missing も true）と合わせて、スイープの可否判定
    // （`persistence::should_sweep_images`）に渡す
    let (notes, notes_loaded, notes_load_error, notes_source_ok) = match load_notes(&data_dir) {
        Loaded::Missing => (Vec::new(), true, None, false),
        Loaded::Ok(v) => (v, true, None, true),
        Loaded::Unreadable(e) => (Vec::new(), false, Some(e), false),
    };
    let (settings, settings_loaded, settings_load_error) = match load_settings(&data_dir) {
        Loaded::Missing => (Settings::default(), true, None),
        Loaded::Ok(v) => (v, true, None),
        Loaded::Unreadable(e) => (Settings::default(), false, Some(e)),
    };
    let (trash, trash_loaded, trash_load_error, trash_source_ok) = match load_trash(&data_dir) {
        Loaded::Missing => (Vec::new(), true, None, false),
        Loaded::Ok(v) => (v, true, None, true),
        Loaded::Unreadable(e) => (Vec::new(), false, Some(e), false),
    };
    let state = AppState {
        notes: Mutex::new(notes),
        settings: Mutex::new(settings),
        trash: Mutex::new(trash),
        last_bring_to_front: Mutex::new(Instant::now() - std::time::Duration::from_secs(10)),
        context_menu_note_id: Mutex::new(String::new()),
        context_menu_image_path: Mutex::new(None),
        data_dir,
        notes_loaded,
        settings_loaded,
        trash_loaded,
        notes_load_error,
        settings_load_error,
        trash_load_error,
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
        .plugin(tauri_plugin_opener::init())
        // ログは補助機能なので、初期化に失敗しても起動は止めない。
        // `tauri_plugin_log::Builder::build()` は内部で失敗を setup の Err として
        // 伝播させ、`app.build().expect(...)` の panic につながる。`split()` +
        // `attach_logger()` を自前の plugin setup 内で呼び、エラーは握り潰して
        // 常に `Ok(())` を返すことでこの経路を避ける
        .plugin(
            tauri::plugin::Builder::<_, ()>::new("hattotto-log")
                .setup(|app_handle, _api| {
                    let split = tauri_plugin_log::Builder::new()
                        .targets([
                            Target::new(TargetKind::LogDir { file_name: None }),
                            Target::new(TargetKind::Stdout),
                        ])
                        .max_file_size(1_000_000)
                        .rotation_strategy(RotationStrategy::KeepOne)
                        // 依存クレート（tauri / wry / tao 等）の Info ログで
                        // 1MB のローテーション上限を食い切ると、追跡したい
                        // 自アプリの error まで KeepOne で失われる。全体は Warn
                        // に絞り、自クレートだけ Info まで通す
                        .level(log::LevelFilter::Warn)
                        .level_for(env!("CARGO_PKG_NAME"), log::LevelFilter::Info)
                        .split(app_handle);
                    match split {
                        Ok((_plugin, max_level, logger)) => {
                            if let Err(e) = tauri_plugin_log::attach_logger(max_level, logger) {
                                eprintln!("Failed to attach logger: {e}");
                            }
                        }
                        Err(e) => eprintln!("Failed to initialize logger: {e}"),
                    }
                    Ok(())
                })
                .build(),
        )
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
            commands::save_pasted_image,
            commands::open_image,
            commands::delete_image,
            commands::copy_image,
            commands::cut_image,
        ])
        .setup(move |app| {
            // Set up app menu and system tray
            if let Err(e) = menu::setup_app_menu(app.handle()) {
                log::error!("Failed to setup app menu: {e}");
            }
            if let Err(e) = tray::setup_tray(app.handle()) {
                log::error!("Failed to setup tray: {e}");
            }

            let state: State<AppState> = app.state();

            // データファイルが読めなかった場合、付箋ウィンドウを開かずに伝えて終了する。
            // このまま起動を続けても保存は拒否されるので、ユーザーがファイルを片付けて
            // 起動し直せる状態に戻すのが唯一の道筋になる。
            let unreadable = [
                ("notes.json", state.notes_loaded),
                ("settings.json", state.settings_loaded),
                ("trash.json", state.trash_loaded),
            ]
            .iter()
            .filter(|(_, loaded)| !loaded)
            .map(|(name, _)| *name)
            .collect::<Vec<_>>();

            // 原因をログに残す。ファイルの中身（付箋本文等）は含めず、
            // io / serde エラーの文字列だけを出す
            for (name, err) in [
                ("notes.json", &state.notes_load_error),
                ("settings.json", &state.settings_load_error),
                ("trash.json", &state.trash_load_error),
            ] {
                if let Some(e) = err {
                    log::error!("data file unreadable: {name} ({e})");
                }
            }

            if !unreadable.is_empty() {
                let lang = i18n::resolve(state.settings.recover().language);
                let separator = match lang {
                    Lang::Ja => "、",
                    Lang::En => ", ",
                };
                let open_folder = app
                    .dialog()
                    .message(
                        i18n::text(lang, Msg::DataLoadFailed)
                            .replace("{files}", &unreadable.join(separator)),
                    )
                    .title(i18n::app_name(lang))
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        i18n::text(lang, Msg::DataLoadFailedOpenFolder).to_string(),
                        i18n::text(lang, Msg::DataLoadFailedCancel).to_string(),
                    ))
                    .blocking_show();

                if open_folder {
                    // データフォルダ名が .app で終わるため、Finder はこれをアプリケーション
                    // バンドルとみなし、フォルダとして開けない。-R でファイルを選択状態に
                    // すれば起動を試みずに済む。直後にプロセスを落とすので完了を待つ
                    let result = std::process::Command::new("open")
                        .arg("-R")
                        .args(unreadable.iter().map(|name| state.data_dir.join(name)))
                        .status();
                    match result {
                        Ok(status) if !status.success() => {
                            log::error!("Failed to reveal data files: open exited with {status}");
                        }
                        Err(e) => log::error!("Failed to reveal data files: {e}"),
                        Ok(_) => {}
                    }
                }
                // Tauri の終了処理を通さずに落とす。この状態では何も書き込ませたくない
                std::process::exit(0);
            }

            // single-instance プラグインは他のプラグインより先に登録してあり、2 個目の
            // インスタンスはここへ来る前に exit している。全プラグイン登録後のこの
            // setup 内でスイープすることで、1 個目のインスタンスの undo 履歴にしか
            // 参照が無い画像や、ペースト直後でデバウンス保存前の画像を
            // 2 個目のインスタンスが誤って消す事故を避ける
            if persistence::should_sweep_images(
                state.notes_loaded,
                state.trash_loaded,
                notes_source_ok,
                trash_source_ok,
            ) {
                let notes_guard = state.notes.recover();
                let trash_guard = state.trash.recover();
                persistence::sweep_orphaned_images(&state.data_dir, &notes_guard, &trash_guard);
            }

            // Restore saved notes
            let notes = state.notes.recover().clone();

            if notes.is_empty() {
                // Create default notes on first launch — one in Japanese, one in
                // English, so a first-time user sees both regardless of OS locale.
                drop(notes);
                let default_color = state.settings.recover().default_color.clone();
                let color = resolve_color(&default_color);

                let mut note_ja = Note::new(&color);
                note_ja.content = String::from(i18n::welcome_note(Lang::Ja));

                let mut note_en = Note::new(&color);
                note_en.content = String::from(i18n::welcome_note(Lang::En));
                note_en.x += note_en.width + 20.0;

                open_note_window(app.handle(), &note_ja);
                open_note_window(app.handle(), &note_en);
                let mut notes = state.notes.recover();
                notes.push(note_ja);
                notes.push(note_en);
                if let Err(e) = save_notes(&state, &notes) {
                    log::error!("save notes error: {}", e);
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
