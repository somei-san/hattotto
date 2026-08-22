use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;

use crate::model::{is_valid_default_color, AppState, Note, Settings, TRASH_MAX};

/// ファイル読み込みの結果。「無い」「読めた」「あるが読めない」を区別する。
/// `Vec<Note>` の `Default` が空であるのと同じ形になってしまう `Unreadable` を
/// `Missing` と混同すると、読み込み失敗を初回起動と誤認して既存データを上書きしうる。
pub(crate) enum Loaded<T> {
    /// ファイルが存在しない。初回起動として扱ってよい
    Missing,
    Ok(T),
    /// ファイルはあるが読み取り・パースに失敗した。上書き保存してはいけない。
    /// 理由文字列はログ用（io / serde エラーの `to_string()`）。ファイルの内容は含まない
    Unreadable(String),
}

// ── Persistence ─────────────────────────────────────────────

pub(crate) fn data_dir() -> PathBuf {
    let dir = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.hattotto.app");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn data_file(dir: &Path) -> PathBuf {
    dir.join("notes.json")
}

fn settings_file(dir: &Path) -> PathBuf {
    dir.join("settings.json")
}

fn trash_file(dir: &Path) -> PathBuf {
    dir.join("trash.json")
}

/// tmp へ書き、fsync してから rename する。
///
/// rename の永続化までは保証しない。電源断で rename が失われても残るのは完全な旧ファイルで、
/// 失うのは直前の保存 1 回分だけなので、中途半端な内容のファイルにはならない。
///
/// tmp 名は書き込みごとには変えない。クラッシュで残った tmp が溜まるのを避けるためで、
/// 使い回しても衝突しないのは、プロセス ID で他プロセスと分かれ、同一プロセス内では
/// Tauri コマンドがメインスレッドで直列に実行されるからである。
fn atomic_write(path: &Path, data: &str) -> Result<(), String> {
    // 保存先ディレクトリが起動後に消されても、次の保存で作り直して復帰できるようにする。
    // 作成に失敗しても直後の File::create が理由付きで失敗するので、ここでは握り潰す
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let tmp = path.with_file_name(format!(
        "{}.tmp.{}",
        path.file_name().unwrap().to_string_lossy(),
        std::process::id()
    ));
    let written = (|| -> io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(data.as_bytes())?;
        // Apple プラットフォームでは F_FULLFSYNC になり、ディスクのキャッシュまで書き出す
        f.sync_all()
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(format!("{}: {}", tmp.display(), e));
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename {} -> {}: {}", tmp.display(), path.display(), e)
    })
}

fn load_json<T: DeserializeOwned>(path: &Path) -> Loaded<T> {
    // `Path::exists()` は I/O エラーでも false を返すため、故障中のディスクを
    // 「ファイルが無い」と誤認する。`Missing` に倒せるのは NotFound のときだけ
    match fs::metadata(path) {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Loaded::Missing,
        Err(e) => return Loaded::Unreadable(e.to_string()),
    }
    match fs::read_to_string(path) {
        Ok(s) => match serde_json::from_str(&s) {
            Ok(v) => Loaded::Ok(v),
            // serde エラーの Display はファイル内の文字列値を逐語で含みうる
            // （付箋本文がログに漏れる）ため、種別と位置だけを残す
            Err(e) => Loaded::Unreadable(format!(
                "{:?} error at line {} column {}",
                e.classify(),
                e.line(),
                e.column()
            )),
        },
        Err(e) => Loaded::Unreadable(e.to_string()),
    }
}

fn save_json<T: serde::Serialize + ?Sized>(
    data: &T,
    path: &Path,
    label: &str,
) -> Result<(), String> {
    let json = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    atomic_write(path, &json).map_err(|e| format!("Failed to save {}: {}", label, e))
}

fn load_notes_from(path: &Path) -> Loaded<Vec<Note>> {
    load_json(path)
}

pub(crate) fn load_notes(dir: &Path) -> Loaded<Vec<Note>> {
    load_notes_from(&data_file(dir))
}

fn save_notes_to(notes: &[Note], path: &Path) -> Result<(), String> {
    save_json(notes, path, "notes")
}

/// 起動時に 1 つでも読めなかったファイルがあれば `Err` を返す。読めなかった元データを
/// 空データや既定値で上書きしないためのガード。
///
/// ファイル単位で許すと、読めたファイルだけが更新されてファイル間の対応が崩れる。
/// notes.json だけが書ける状態で付箋を削除すると、付箋一覧からは消えるのに
/// ゴミ箱には入らない。
fn refuse_if_unloaded(state: &AppState) -> Result<(), String> {
    if state.notes_loaded && state.settings_loaded && state.trash_loaded {
        return Ok(());
    }
    Err("Refusing to save: a data file failed to load at startup".to_string())
}

pub(crate) fn save_notes(state: &AppState, notes: &[Note]) -> Result<(), String> {
    refuse_if_unloaded(state)?;
    save_notes_to(notes, &data_file(&state.data_dir))
}

fn load_settings_from(path: &Path) -> Loaded<Settings> {
    match load_json::<Settings>(path) {
        Loaded::Ok(mut s) => {
            // 未知の `language` を `Auto` に倒すのと同じ方針で、手編集などで壊れた
            // `default_color` も既定色に倒し、不正値のまま付箋が作られるのを防ぐ
            if !is_valid_default_color(&s.default_color) {
                s.default_color = Settings::default().default_color;
            }
            Loaded::Ok(s)
        }
        other => other,
    }
}

pub(crate) fn load_settings(dir: &Path) -> Loaded<Settings> {
    load_settings_from(&settings_file(dir))
}

fn save_settings_to(settings: &Settings, path: &Path) -> Result<(), String> {
    save_json(settings, path, "settings")
}

pub(crate) fn save_settings(state: &AppState, settings: &Settings) -> Result<(), String> {
    refuse_if_unloaded(state)?;
    save_settings_to(settings, &settings_file(&state.data_dir))
}

fn load_trash_from(path: &Path) -> Loaded<Vec<Note>> {
    load_json(path)
}

pub(crate) fn load_trash(dir: &Path) -> Loaded<Vec<Note>> {
    load_trash_from(&trash_file(dir))
}

fn save_trash_to(trash: &[Note], path: &Path) -> Result<(), String> {
    save_json(trash, path, "trash")
}

pub(crate) fn save_trash(state: &AppState, trash: &[Note]) -> Result<(), String> {
    refuse_if_unloaded(state)?;
    save_trash_to(trash, &trash_file(&state.data_dir))
}

/// ゴミ箱のFIFO制限: TRASH_MAXを超えた分を先頭から削除
pub(crate) fn enforce_trash_limit(trash: &mut Vec<Note>) {
    let overflow = trash.len().saturating_sub(TRASH_MAX);
    if overflow > 0 {
        trash.drain(0..overflow);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::LanguageSetting;
    use std::sync::Mutex;
    use std::time::Instant;
    use tempfile::TempDir;

    fn make_note(id: &str, color: &str, content: &str) -> Note {
        Note {
            id: id.to_string(),
            content: content.to_string(),
            color: color.to_string(),
            x: 0.0,
            y: 0.0,
            width: 280.0,
            height: 320.0,
            zoom: 100,
            pinned: false,
            deleted_at: None,
        }
    }

    /// テスト用の `AppState`。ロード済みフラグ以外は使わない。
    fn make_state(
        data_dir: &Path,
        notes_loaded: bool,
        settings_loaded: bool,
        trash_loaded: bool,
    ) -> AppState {
        AppState {
            notes: Mutex::new(Vec::new()),
            settings: Mutex::new(Settings::default()),
            trash: Mutex::new(Vec::new()),
            last_bring_to_front: Mutex::new(Instant::now()),
            context_menu_note_id: Mutex::new(String::new()),
            data_dir: data_dir.to_path_buf(),
            notes_loaded,
            settings_loaded,
            trash_loaded,
            notes_load_error: None,
            settings_load_error: None,
            trash_load_error: None,
        }
    }

    fn unwrap_ok<T>(loaded: Loaded<T>) -> T {
        match loaded {
            Loaded::Ok(v) => v,
            _ => panic!("expected Loaded::Ok"),
        }
    }

    // ── Trash FIFO ──

    #[test]
    fn trash_fifo_within_limit() {
        let mut trash: Vec<Note> = (0..TRASH_MAX)
            .map(|i| make_note(&i.to_string(), "yellow", ""))
            .collect();
        enforce_trash_limit(&mut trash);
        assert_eq!(trash.len(), TRASH_MAX);
    }

    #[test]
    fn trash_fifo_overflow_by_one() {
        let mut trash: Vec<Note> = (0..TRASH_MAX + 1)
            .map(|i| make_note(&i.to_string(), "yellow", ""))
            .collect();
        enforce_trash_limit(&mut trash);
        assert_eq!(trash.len(), TRASH_MAX);
        // oldest (id "0") should be removed
        assert_eq!(trash[0].id, "1");
    }

    #[test]
    fn trash_fifo_overflow_by_five() {
        let mut trash: Vec<Note> = (0..TRASH_MAX + 5)
            .map(|i| make_note(&i.to_string(), "yellow", ""))
            .collect();
        enforce_trash_limit(&mut trash);
        assert_eq!(trash.len(), TRASH_MAX);
        assert_eq!(trash[0].id, "5");
        assert_eq!(trash[TRASH_MAX - 1].id, (TRASH_MAX + 4).to_string());
    }

    // ── JSON persistence roundtrip ──

    #[test]
    fn notes_roundtrip() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("notes.json");
        let notes = vec![
            make_note("a", "yellow", "hello"),
            make_note("b", "blue", "world"),
        ];
        save_notes_to(&notes, &path).unwrap();
        let loaded = unwrap_ok(load_notes_from(&path));
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].id, "a");
        assert_eq!(loaded[0].content, "hello");
        assert_eq!(loaded[1].id, "b");
        assert_eq!(loaded[1].color, "blue");
    }

    #[test]
    fn settings_roundtrip() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("settings.json");
        let settings = Settings {
            default_color: "pink".into(),
            opacity: 80,
            bring_all_to_front: false,
            show_pin_button: true,
            show_new_button: true,
            show_color_button: true,
            confirm_before_delete: true,
            language: LanguageSetting::En,
        };
        save_settings_to(&settings, &path).unwrap();
        let loaded = unwrap_ok(load_settings_from(&path));
        assert_eq!(loaded.default_color, "pink");
        assert_eq!(loaded.opacity, 80);
        assert!(!loaded.bring_all_to_front);
        assert!(loaded.confirm_before_delete);
        assert_eq!(loaded.language, LanguageSetting::En);
    }

    #[test]
    fn load_settings_invalid_default_color_falls_back_to_default() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, r#"{"default_color":"vermilion","opacity":100}"#).unwrap();
        let loaded = unwrap_ok(load_settings_from(&path));
        assert_eq!(loaded.default_color, "yellow");
    }

    #[test]
    fn load_settings_random_default_color_is_kept() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, r#"{"default_color":"random","opacity":100}"#).unwrap();
        let loaded = unwrap_ok(load_settings_from(&path));
        assert_eq!(loaded.default_color, "random");
    }

    #[test]
    fn trash_roundtrip() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("trash.json");
        let trash = vec![make_note("t1", "green", "deleted")];
        save_trash_to(&trash, &path).unwrap();
        let loaded = unwrap_ok(load_trash_from(&path));
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "t1");
        assert_eq!(loaded[0].content, "deleted");
    }

    // ── Loaded の3状態 ──

    #[test]
    fn load_notes_nonexistent_returns_missing() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nonexistent.json");
        assert!(matches!(load_notes_from(&path), Loaded::Missing));
    }

    #[test]
    fn load_settings_nonexistent_returns_missing() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nonexistent.json");
        assert!(matches!(load_settings_from(&path), Loaded::Missing));
    }

    #[test]
    fn load_notes_valid_json_returns_ok() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("notes.json");
        let notes = vec![make_note("a", "yellow", "hello")];
        save_notes_to(&notes, &path).unwrap();
        let loaded = unwrap_ok(load_notes_from(&path));
        assert_eq!(loaded.len(), 1);
    }

    #[test]
    fn load_notes_broken_json_returns_unreadable() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("notes.json");
        fs::write(&path, r#"{"broken"#).unwrap();
        assert!(matches!(load_notes_from(&path), Loaded::Unreadable(_)));
    }

    #[test]
    fn load_notes_unreadable_permissions_returns_unreadable() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new().unwrap();
        let path = dir.path().join("notes.json");
        let notes = vec![make_note("a", "yellow", "hello")];
        save_notes_to(&notes, &path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();

        let result = fs::read_to_string(&path);
        // root や CI コンテナ等、パーミッションが効かない環境では検証不能なのでスキップする
        if result.is_ok() {
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
            eprintln!(
                "skipping load_notes_unreadable_permissions_returns_unreadable: \
                 this environment ignores file permissions (likely running as root)"
            );
            return;
        }

        assert!(matches!(load_notes_from(&path), Loaded::Unreadable(_)));
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    }

    /// ファイルの有無すら確認できない状況を `Missing` に倒さないことの確認。
    /// 親ディレクトリの検索権限を落とすと `Path::exists()` は false を返すので、
    /// この経路を `Missing` にすると故障中のディスクで既存データを上書きしてしまう。
    #[test]
    fn load_notes_unstattable_returns_unreadable() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new().unwrap();
        let locked = dir.path().join("locked");
        fs::create_dir(&locked).unwrap();
        let path = locked.join("notes.json");
        save_notes_to(&[make_note("a", "yellow", "hello")], &path).unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();

        let unstattable = fs::metadata(&path).is_err();
        let result = load_notes_from(&path);
        // TempDir が後片付けできるよう、判定前に権限を戻す
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();

        // root や CI コンテナ等、パーミッションが効かない環境では検証不能なのでスキップする
        if !unstattable {
            eprintln!(
                "skipping load_notes_unstattable_returns_unreadable: \
                 this environment ignores directory permissions (likely running as root)"
            );
            return;
        }
        assert!(matches!(result, Loaded::Unreadable(_)));
    }

    // ── atomic_write tests ──

    #[test]
    fn atomic_write_creates_file_with_correct_content() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.json");
        atomic_write(&path, r#"{"hello":"world"}"#).unwrap();
        let content = fs::read_to_string(&path).unwrap();
        assert_eq!(content, r#"{"hello":"world"}"#);
    }

    #[test]
    fn atomic_write_leaves_no_tmp_behind() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.json");
        atomic_write(&path, "first").unwrap();
        atomic_write(&path, "second").unwrap();
        let names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["test.json"]);
    }

    /// 保存先ディレクトリが消えていても作り直して保存できる（自己修復）。
    #[test]
    fn atomic_write_creates_missing_parent_dir() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("no_such_dir").join("file.json");
        atomic_write(&path, "data").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "data");
    }

    // ── save_*_to error path tests ──
    // 親パスを通常ファイルで塞ぐとディレクトリを作れず、保存は失敗する

    #[test]
    fn save_notes_to_blocked_parent_returns_err() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("blocker"), "").unwrap();
        let path = dir.path().join("blocker").join("notes.json");
        let notes = vec![make_note("e1", "yellow", "err")];
        let result = save_notes_to(&notes, &path);
        assert!(result.is_err());
    }

    #[test]
    fn save_settings_to_blocked_parent_returns_err() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("blocker"), "").unwrap();
        let path = dir.path().join("blocker").join("settings.json");
        let result = save_settings_to(&Settings::default(), &path);
        assert!(result.is_err());
    }

    #[test]
    fn save_trash_to_blocked_parent_returns_err() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("blocker"), "").unwrap();
        let path = dir.path().join("blocker").join("trash.json");
        let trash = vec![make_note("t1", "green", "err")];
        let result = save_trash_to(&trash, &path);
        assert!(result.is_err());
    }

    // ── 保存ガード ──

    #[test]
    fn save_notes_refuses_when_not_loaded() {
        let dir = TempDir::new().unwrap();
        let state = make_state(dir.path(), false, true, true);
        let notes = vec![make_note("a", "yellow", "should not be saved")];
        let result = save_notes(&state, &notes);

        assert!(result.is_err());
        assert!(
            !dir.path().join("notes.json").exists(),
            "notes.json must not be created when notes_loaded is false"
        );
    }

    /// 読めなかったのが別のファイルでも保存を止める。
    #[test]
    fn save_notes_refuses_when_another_file_failed_to_load() {
        let dir = TempDir::new().unwrap();
        assert!(refuse_if_unloaded(&make_state(dir.path(), true, false, true)).is_err());
        assert!(refuse_if_unloaded(&make_state(dir.path(), true, true, false)).is_err());
        assert!(refuse_if_unloaded(&make_state(dir.path(), true, true, true)).is_ok());
    }
}
