use std::path::PathBuf;

use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

/// ログイン時自動起動の LaunchAgent に付ける起動時引数。
/// これが付いた起動かどうかで、手動起動と区別する
pub(crate) const AUTOSTART_ARG: &str = "--from-autostart";

pub(crate) fn launched_from_autostart(args: impl IntoIterator<Item = impl AsRef<str>>) -> bool {
    args.into_iter().any(|arg| arg.as_ref() == AUTOSTART_ARG)
}

/// plist の `ProgramArguments` が `exe_path` を指していて、かつ `AUTOSTART_ARG` を
/// まだ含んでいないか
pub(crate) fn needs_plist_rewrite(plist: &str, exe_path: &str) -> bool {
    plist.contains(&format!("<string>{exe_path}</string>"))
        && !plist.contains(&format!("<string>{AUTOSTART_ARG}</string>"))
}

fn plist_path(app: &AppHandle) -> Option<PathBuf> {
    dirs::home_dir().map(|home| {
        home.join("Library")
            .join("LaunchAgents")
            .join(format!("{}.plist", app.package_info().name))
    })
}

/// `AUTOSTART_ARG` を含まない plist を、引数付きで書き直す。
///
/// `autolaunch().enable()` はその時点の実行ファイルパスで plist を丸ごと書き直す。
/// 無条件に呼ぶと `cargo tauri dev` を起動しただけで、本番の plist が開発用バイナリの
/// パスに差し替わってしまう。それを防いでいるのは `needs_plist_rewrite` の
/// パス一致判定で、plist が今の実行ファイルと違うパスを指しているときは書き直さない
pub(crate) fn migrate_launch_agent(app: &AppHandle) {
    let Ok(true) = app.autolaunch().is_enabled() else {
        return;
    };
    let Some(path) = plist_path(app) else {
        return;
    };
    let plist = match std::fs::read_to_string(&path) {
        Ok(plist) => plist,
        Err(e) => {
            log::warn!("Failed to read launch agent plist ({path:?}): {e}");
            return;
        }
    };
    let exe_path = match std::env::current_exe().and_then(|p| p.canonicalize()) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("Failed to resolve current executable path: {e}");
            return;
        }
    };

    if needs_plist_rewrite(&plist, &exe_path.display().to_string()) {
        if let Err(e) = app.autolaunch().enable() {
            log::error!("Failed to migrate launch agent plist: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launched_from_autostart_no_args() {
        assert!(!launched_from_autostart(Vec::<&str>::new()));
    }

    #[test]
    fn launched_from_autostart_with_flag() {
        assert!(launched_from_autostart([
            "/Applications/Hattotto.app/Contents/MacOS/hattotto",
            AUTOSTART_ARG,
        ]));
    }

    #[test]
    fn launched_from_autostart_other_args_only() {
        assert!(!launched_from_autostart([
            "/Applications/Hattotto.app/Contents/MacOS/hattotto",
            "--foo",
        ]));
    }

    const LEGACY_PLIST: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
  <key>Label</key>
  <string>Hattotto</string>
  <key>ProgramArguments</key>
  <array><string>/Applications/Hattotto.app/Contents/MacOS/hattotto</string></array>
  <key>RunAtLoad</key>
  <true/>
  </dict>
</plist>
"#;

    #[test]
    fn needs_plist_rewrite_legacy_plist_matching_path() {
        assert!(needs_plist_rewrite(
            LEGACY_PLIST,
            "/Applications/Hattotto.app/Contents/MacOS/hattotto",
        ));
    }

    #[test]
    fn needs_plist_rewrite_already_has_arg() {
        let plist = LEGACY_PLIST.replace(
            "<string>/Applications/Hattotto.app/Contents/MacOS/hattotto</string>",
            "<string>/Applications/Hattotto.app/Contents/MacOS/hattotto</string><string>--from-autostart</string>",
        );
        assert!(!needs_plist_rewrite(
            &plist,
            "/Applications/Hattotto.app/Contents/MacOS/hattotto",
        ));
    }

    #[test]
    fn needs_plist_rewrite_path_mismatch() {
        assert!(!needs_plist_rewrite(
            LEGACY_PLIST,
            "/Users/someone/Repos/hattotto/src-tauri/target/debug/hattotto",
        ));
    }
}
