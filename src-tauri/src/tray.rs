use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, State,
};

use crate::i18n::{self, Lang, Msg};
use crate::model::{AppState, RecoverMutex};
use crate::window::{create_note_with_window, open_settings_window};

// ── System Tray ─────────────────────────────────────────────

/// トレイアイコンの固定 ID。言語変更時に `app.tray_by_id` で取り直して更新するために使う。
const TRAY_ID: &str = "main-tray";

/// 起動時に一度だけ呼ぶ。トレイアイコンを作成してイベントハンドラを登録する。
/// 言語切り替えでの組み直しは `rebuild_tray` を使う（同じ ID でアイコンが二重に生えないようにするため）。
pub(crate) fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let lang = i18n::resolve(app.state::<AppState>().settings.recover().language);
    let menu = build_menu(app, lang)?;

    let icon = tauri::include_image!("icons/tray.png");

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .menu(&menu)
        .tooltip(i18n::app_name(lang))
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

/// 現在の設定言語でトレイのメニューとツールチップを組み直す。
pub(crate) fn rebuild_tray(app: &AppHandle) -> tauri::Result<()> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    let lang = i18n::resolve(app.state::<AppState>().settings.recover().language);
    let menu = build_menu(app, lang)?;
    tray.set_menu(Some(menu))?;
    tray.set_tooltip(Some(i18n::app_name(lang)))?;
    Ok(())
}

fn build_menu(app: &AppHandle, lang: Lang) -> tauri::Result<Menu<tauri::Wry>> {
    let new_note = MenuItem::with_id(
        app,
        "tray_new_note",
        i18n::text(lang, Msg::NewNote),
        true,
        Some("CmdOrCtrl+N"),
    )?;
    let settings = MenuItem::with_id(
        app,
        "settings",
        i18n::text(lang, Msg::TraySettingsHelp),
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let quit = MenuItem::with_id(
        app,
        "quit",
        i18n::text(lang, Msg::TrayQuit),
        true,
        Some("CmdOrCtrl+Q"),
    )?;
    Menu::with_items(app, &[&new_note, &settings, &quit])
}
