//! UI 文言の言語ごとの表記。
//!
//! 文言は Rust 側の表として持ち、`Msg` を増やしたときに訳が欠けていればコンパイル
//! エラーになるようにしている（`.lproj` / ローカライズリソースは使わない）。

use sys_locale::get_locale;

use crate::model::LanguageSetting;

/// 表示に使う言語。`LanguageSetting::Auto` を OS のロケールで解決した結果でもある。
///
/// シリアライズ結果の `"ja"` / `"en"` は `get_settings` の `system_language` として
/// フロントエンドへ渡り、`src/i18n.js` の `resolve` が文字列比較する。
/// variant 名や rename 規則を変えるときはフロントエンド側も揃えること。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Lang {
    Ja,
    En,
}

/// 言語ごとの表記を持つ UI 文言。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Msg {
    MenuSettings,
    MenuTrash,
    MenuFile,
    MenuCloseWindow,
    MenuEdit,
    MenuActualSize,
    MenuView,
    MenuHelp,
    MenuHattottoHelp,
    NewNote,
    ZoomIn,
    ZoomOut,

    TraySettingsHelp,
    TrayQuit,

    SettingsWindowTitle,
    TrashWindowTitle,

    DeleteConfirmMessage,
    DeleteConfirmOk,
    DeleteConfirmCancel,

    /// 読み込めなかったファイル名を差し込む `{files}` を含む
    DataLoadFailed,
    DataLoadFailedOpenFolder,
    DataLoadFailedCancel,

    CtxPin,
    CtxUnpin,
    CtxDelete,
    CtxOpenTrash,
    CtxZoomReset,
    CtxOpenSettings,

    ColorYellow,
    ColorBlue,
    ColorGreen,
    ColorPink,
    ColorPurple,
    ColorGray,
}

pub(crate) fn text(lang: Lang, msg: Msg) -> &'static str {
    let (ja, en) = match msg {
        Msg::MenuSettings => ("設定…", "Settings…"),
        Msg::MenuTrash => ("ゴミ箱…", "Trash…"),
        Msg::MenuFile => ("ファイル", "File"),
        Msg::MenuCloseWindow => ("ウィンドウを閉じる", "Close Window"),
        Msg::MenuEdit => ("編集", "Edit"),
        Msg::MenuActualSize => ("実寸大", "Actual Size"),
        Msg::MenuView => ("表示", "View"),
        Msg::MenuHelp => ("ヘルプ", "Help"),
        Msg::MenuHattottoHelp => ("貼っとっと ヘルプ", "Hattotto Help"),
        Msg::NewNote => ("新しい付箋", "New Note"),
        Msg::ZoomIn => ("ズームイン", "Zoom In"),
        Msg::ZoomOut => ("ズームアウト", "Zoom Out"),

        Msg::TraySettingsHelp => ("設定 / ヘルプ", "Settings / Help"),
        Msg::TrayQuit => ("終了", "Quit"),

        Msg::SettingsWindowTitle => ("貼っとっと — 設定 / ヘルプ", "Hattotto — Settings / Help"),
        Msg::TrashWindowTitle => ("ゴミ箱", "Trash"),

        Msg::DeleteConfirmMessage => ("この付箋を削除しますか？", "Delete this note?"),
        Msg::DeleteConfirmOk => ("削除", "Delete"),
        Msg::DeleteConfirmCancel => ("キャンセル", "Cancel"),

        Msg::DataLoadFailed => (
            "{files} を読み込めませんでした。\n\n中身が壊れているか、ファイルを開けない状態です。ファイルは削除していません。\n\n該当のファイルを削除するか、JSON として読める状態に直してから、貼っとっとを起動し直してください。",
            "Hattotto could not read the following data: {files}\n\nNothing has been deleted. The data is either damaged or cannot be opened.\n\nDelete or repair it so that it is valid JSON, then start Hattotto again.",
        ),
        Msg::DataLoadFailedOpenFolder => ("Finder で表示", "Show in Finder"),
        Msg::DataLoadFailedCancel => ("起動をキャンセル", "Cancel Launch"),

        Msg::CtxPin => ("ピン留め", "Pin"),
        Msg::CtxUnpin => ("ピン留め解除", "Unpin"),
        Msg::CtxDelete => ("この付箋を削除", "Delete This Note"),
        Msg::CtxOpenTrash => ("ゴミ箱を開く", "Open Trash"),
        Msg::CtxZoomReset => ("ズームリセット", "Reset Zoom"),
        Msg::CtxOpenSettings => ("設定を開く", "Open Settings"),

        Msg::ColorYellow => ("イエロー", "Yellow"),
        Msg::ColorBlue => ("ブルー", "Blue"),
        Msg::ColorGreen => ("グリーン", "Green"),
        Msg::ColorPink => ("ピンク", "Pink"),
        Msg::ColorPurple => ("パープル", "Purple"),
        Msg::ColorGray => ("グレー", "Gray"),
    };

    match lang {
        Lang::Ja => ja,
        Lang::En => en,
    }
}

/// UI に出すアプリ名。`tauri.conf.json` の `identifier` / `productName` は変えない
/// （DMG 名・Homebrew cask・データ保存先が参照しているため）。
pub(crate) fn app_name(lang: Lang) -> &'static str {
    match lang {
        Lang::Ja => "貼っとっと",
        Lang::En => "Hattotto",
    }
}

/// コンテキストメニューの色名。`key` は `COLOR_DEFS` の `key`（永続化値）と対応する。
pub(crate) fn color_label(lang: Lang, key: &'static str) -> &'static str {
    let msg = match key {
        "yellow" => Msg::ColorYellow,
        "blue" => Msg::ColorBlue,
        "green" => Msg::ColorGreen,
        "pink" => Msg::ColorPink,
        "purple" => Msg::ColorPurple,
        "gray" => Msg::ColorGray,
        _ => return key,
    };
    text(lang, msg)
}

/// 初回起動時に表示するサンプル付箋の本文。
pub(crate) fn welcome_note(lang: Lang) -> &'static str {
    match lang {
        Lang::Ja => "# 貼っとっとへようこそ！\n\n- クリックした行だけ編集、外クリックでプレビュー\n- **太字** や *斜体* が使えます\n- [x] チェックボックスも\n- [ ] クリックで切替\n\n> 右クリックでメニュー、⌘N で新しい付箋",
        Lang::En => "# Welcome to Hattotto!\n\n- Click a line to edit it, click outside to preview\n- **Bold** and *italic* work\n- [x] Checkboxes too\n- [ ] Click to toggle\n\n> Right-click for the menu, ⌘N for a new note",
    }
}

/// 設定値を実際に表示に使う言語へ解決する。
pub(crate) fn resolve(setting: LanguageSetting) -> Lang {
    resolve_with_system(setting, system_language())
}

/// `resolve` から OS のロケール参照を引数として切り離したもの。
/// テストが OS の実ロケールに依存せず `system` を固定値で注入できるようにしている。
pub(crate) fn resolve_with_system(setting: LanguageSetting, system: Lang) -> Lang {
    match setting {
        LanguageSetting::Auto => system,
        LanguageSetting::Ja => Lang::Ja,
        LanguageSetting::En => Lang::En,
    }
}

/// OS のロケールから表示言語を決める。取得できなければ英語に倒す。
pub(crate) fn system_language() -> Lang {
    match get_locale() {
        Some(tag) => lang_from_bcp47(&tag),
        None => Lang::En,
    }
}

/// BCP 47 の言語タグ（`ja-JP` など）から表示言語を決める。
pub(crate) fn lang_from_bcp47(tag: &str) -> Lang {
    let primary = tag.split(['-', '_']).next().unwrap_or("");
    if primary.eq_ignore_ascii_case("ja") {
        Lang::Ja
    } else {
        Lang::En
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lang_from_bcp47_picks_japanese_only_for_ja() {
        assert_eq!(lang_from_bcp47("ja"), Lang::Ja);
        assert_eq!(lang_from_bcp47("ja-JP"), Lang::Ja);
        assert_eq!(lang_from_bcp47("ja_JP"), Lang::Ja);
        assert_eq!(lang_from_bcp47("JA-jp"), Lang::Ja);
        assert_eq!(lang_from_bcp47("en-US"), Lang::En);
        assert_eq!(lang_from_bcp47("jam"), Lang::En);
        assert_eq!(lang_from_bcp47(""), Lang::En);
    }

    #[test]
    fn resolve_with_system_follows_system_only_for_auto() {
        assert_eq!(
            resolve_with_system(LanguageSetting::Auto, Lang::Ja),
            Lang::Ja
        );
        assert_eq!(
            resolve_with_system(LanguageSetting::Auto, Lang::En),
            Lang::En
        );
        assert_eq!(resolve_with_system(LanguageSetting::Ja, Lang::En), Lang::Ja);
        assert_eq!(resolve_with_system(LanguageSetting::En, Lang::Ja), Lang::En);
    }

    /// アプリ名を含む文言。表記が `app_name` からずれると、メニューとウィンドウ
    /// タイトルで名前が食い違って見える。
    #[test]
    fn messages_naming_the_app_use_the_display_name() {
        for msg in [Msg::SettingsWindowTitle, Msg::MenuHattottoHelp] {
            for lang in [Lang::Ja, Lang::En] {
                let rendered = text(lang, msg);
                assert!(
                    rendered.contains(app_name(lang)),
                    "{msg:?} ({lang:?}) に {} が無い: {rendered}",
                    app_name(lang)
                );
            }
        }
    }

    #[test]
    fn color_label_covers_all_known_keys() {
        for key in ["yellow", "blue", "green", "pink", "purple", "gray"] {
            assert_ne!(color_label(Lang::Ja, key), key);
            assert_ne!(color_label(Lang::En, key), key);
        }
    }

    #[test]
    fn color_label_unknown_key_passthrough() {
        assert_eq!(color_label(Lang::Ja, "bogus"), "bogus");
    }
}
