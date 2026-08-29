use tauri::{
    menu::{IconMenuItem, Menu, MenuItem, NativeIcon, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Manager, State,
};

use crate::commands::{confirm_delete_if_needed, do_delete_note};
use crate::i18n::{self, Lang, Msg};
use crate::model::{AppState, RecoverMutex};
use crate::window::{create_note_with_window, open_settings_window, open_trash_window};

// ── App Menu ────────────────────────────────────────────────

/// 起動時に一度だけ呼ぶ。メニューを構築してイベントハンドラを登録する。
/// 言語切り替えでの組み直しは `rebuild_app_menu` を使う
/// （`on_menu_event` は呼ぶたびにリスナーが積み重なるため、ここでは一度しか登録しない）。
pub(crate) fn setup_app_menu(app: &AppHandle) -> tauri::Result<()> {
    rebuild_app_menu(app)?;

    app.on_menu_event(|app, event| {
        let eid = event.id();
        let eid_str = eid.as_ref();
        // Context menu events (ctx_ prefix)
        if eid_str.starts_with("ctx_") {
            crate::context_menu::handle_context_menu_event(app, eid_str);
            return;
        }
        match eid_str {
            "close_window" => {
                if let Some(win) = app.get_focused_window() {
                    let label = win.label().to_string();
                    if let Some(note_id) = label.strip_prefix("note-") {
                        let state: State<AppState> = app.state();
                        if confirm_delete_if_needed(app, &state, note_id) {
                            if let Err(e) = do_delete_note(note_id, app, &state) {
                                log::error!("delete note error: {}", e);
                            }
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
            "undo" => {
                let _ = app.emit("edit-history", "undo");
            }
            "redo" => {
                let _ = app.emit("edit-history", "redo");
            }
            "select_all" => {
                let _ = app.emit("select-all", ());
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

/// 現在の設定言語でメニューを組み直す。初回構築と言語変更時の両方から呼ばれる。
pub(crate) fn rebuild_app_menu(app: &AppHandle) -> tauri::Result<()> {
    let lang = i18n::resolve(app.state::<AppState>().settings.recover().language);
    let menu = build_menu(app, lang)?;
    app.set_menu(menu)?;
    Ok(())
}

fn build_menu(app: &AppHandle, lang: Lang) -> tauri::Result<Menu<tauri::Wry>> {
    let settings_item = MenuItem::with_id(
        app,
        "open_settings",
        i18n::text(lang, Msg::MenuSettings),
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let new_note_item = IconMenuItem::with_id_and_native_icon(
        app,
        "new_note",
        i18n::text(lang, Msg::NewNote),
        true,
        Some(NativeIcon::Add),
        Some("CmdOrCtrl+N"),
    )?;

    // macOS のメニューバー左端（アプリケーションメニュー）のタイトルは CFBundleName
    // （tauri.conf.json の productName）から決まり、ここに渡す i18n::app_name(lang) は
    // 表示に反映されない。同じ理由で、このサブメニュー内の PredefinedMenuItem::about /
    // hide / quit も bundle 名を含む英語表記のまま出る。
    let app_submenu = Submenu::with_items(
        app,
        i18n::app_name(lang),
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
        i18n::text(lang, Msg::MenuTrash),
        true,
        Some(NativeIcon::TrashEmpty),
        Some("CmdOrCtrl+Shift+T"),
    )?;

    let file_submenu = Submenu::with_items(
        app,
        i18n::text(lang, Msg::MenuFile),
        true,
        &[
            &new_note_item,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "close_window",
                i18n::text(lang, Msg::MenuCloseWindow),
                true,
                Some("CmdOrCtrl+W"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &trash_item,
        ],
    )?;

    // PredefinedMenuItem::undo/redo は macOS の NSUndoManager と結び付いており、⌘Z/⌘⇧Z を
    // WebView 側の keydown より先に奪う。付箋は独自の undo/redo 履歴（history.js）を持つため、
    // ここは通常の MenuItem にして edit-history イベント経由でフロントへ委ねる。
    // select_all も同じ理由でカスタム MenuItem にする。PredefinedMenuItem::select_all は
    // WKWebView 標準の選択（フォーカス中の contenteditable 内だけ）に閉じてしまい、付箋全体
    // （生エディタが閉じている状態も含む）を選択できない。select-all イベント経由で
    // note.js の selectAllNote を呼ぶ
    let edit_submenu = Submenu::with_items(
        app,
        i18n::text(lang, Msg::MenuEdit),
        true,
        &[
            &MenuItem::with_id(
                app,
                "undo",
                i18n::text(lang, Msg::MenuUndo),
                true,
                Some("CmdOrCtrl+Z"),
            )?,
            &MenuItem::with_id(
                app,
                "redo",
                i18n::text(lang, Msg::MenuRedo),
                true,
                Some("CmdOrCtrl+Shift+Z"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &MenuItem::with_id(
                app,
                "select_all",
                i18n::text(lang, Msg::MenuSelectAll),
                true,
                Some("CmdOrCtrl+A"),
            )?,
        ],
    )?;

    let zoom_in_item = MenuItem::with_id(
        app,
        "zoom_in",
        i18n::text(lang, Msg::ZoomIn),
        true,
        Some("CmdOrCtrl+="),
    )?;
    let zoom_out_item = MenuItem::with_id(
        app,
        "zoom_out",
        i18n::text(lang, Msg::ZoomOut),
        true,
        Some("CmdOrCtrl+-"),
    )?;
    let zoom_reset_item = MenuItem::with_id(
        app,
        "zoom_reset",
        i18n::text(lang, Msg::MenuActualSize),
        true,
        Some("CmdOrCtrl+0"),
    )?;
    let view_submenu = Submenu::with_items(
        app,
        i18n::text(lang, Msg::MenuView),
        true,
        &[&zoom_in_item, &zoom_out_item, &zoom_reset_item],
    )?;

    let help_item = MenuItem::with_id(
        app,
        "open_help",
        i18n::text(lang, Msg::MenuHattottoHelp),
        true,
        None::<&str>,
    )?;
    let help_submenu =
        Submenu::with_items(app, i18n::text(lang, Msg::MenuHelp), true, &[&help_item])?;

    Menu::with_items(
        app,
        &[
            &app_submenu,
            &file_submenu,
            &edit_submenu,
            &view_submenu,
            &help_submenu,
        ],
    )
}
