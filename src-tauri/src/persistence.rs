use std::fs;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;

use crate::model::{Note, Settings, TRASH_MAX};

// ── Persistence ─────────────────────────────────────────────

fn data_dir() -> PathBuf {
    let dir = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.hatto-to.app");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn data_file() -> PathBuf {
    data_dir().join("notes.json")
}

fn settings_file() -> PathBuf {
    data_dir().join("settings.json")
}

fn trash_file() -> PathBuf {
    data_dir().join("trash.json")
}

fn atomic_write(path: &Path, data: &str) -> Result<(), String> {
    let tmp = path.with_file_name(format!(
        "{}.tmp.{}",
        path.file_name().unwrap().to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    fs::write(&tmp, data).map_err(|e| format!("{}: {}", tmp.display(), e))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename {} -> {}: {}", tmp.display(), path.display(), e)
    })
}

fn load_json<T: DeserializeOwned + Default>(path: &Path) -> T {
    if path.exists() {
        fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        T::default()
    }
}

fn save_json<T: serde::Serialize + ?Sized>(data: &T, path: &Path, label: &str) -> Result<(), String> {
    let json = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    atomic_write(path, &json).map_err(|e| format!("Failed to save {}: {}", label, e))
}

fn load_notes_from(path: &Path) -> Vec<Note> {
    load_json(path)
}

pub(crate) fn load_notes() -> Vec<Note> {
    load_notes_from(&data_file())
}

fn save_notes_to(notes: &[Note], path: &Path) -> Result<(), String> {
    save_json(notes, path, "notes")
}

pub(crate) fn save_notes(notes: &[Note]) {
    if let Err(e) = save_notes_to(notes, &data_file()) {
        eprintln!("{}", e);
    }
}

fn load_settings_from(path: &Path) -> Settings {
    load_json(path)
}

pub(crate) fn load_settings() -> Settings {
    load_settings_from(&settings_file())
}

fn save_settings_to(settings: &Settings, path: &Path) -> Result<(), String> {
    save_json(settings, path, "settings")
}

pub(crate) fn save_settings(settings: &Settings) {
    if let Err(e) = save_settings_to(settings, &settings_file()) {
        eprintln!("{}", e);
    }
}

fn load_trash_from(path: &Path) -> Vec<Note> {
    load_json(path)
}

pub(crate) fn load_trash() -> Vec<Note> {
    load_trash_from(&trash_file())
}

fn save_trash_to(trash: &[Note], path: &Path) -> Result<(), String> {
    save_json(trash, path, "trash")
}

pub(crate) fn save_trash(trash: &[Note]) {
    if let Err(e) = save_trash_to(trash, &trash_file()) {
        eprintln!("{}", e);
    }
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
        let loaded = load_notes_from(&path);
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
            font_size: 18,
            zoom: 150,
            opacity: 80,
            edit_on_single_click: true,
            bring_all_to_front: false,
            show_pin_button: true,
            show_new_button: true,
            show_color_button: true,
            confirm_before_delete: true,
        };
        save_settings_to(&settings, &path).unwrap();
        let loaded = load_settings_from(&path);
        assert_eq!(loaded.default_color, "pink");
        assert_eq!(loaded.font_size, 18);
        assert_eq!(loaded.zoom, 150);
        assert_eq!(loaded.opacity, 80);
        assert!(loaded.edit_on_single_click);
        assert!(loaded.confirm_before_delete);
    }

    #[test]
    fn trash_roundtrip() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("trash.json");
        let trash = vec![make_note("t1", "green", "deleted")];
        save_trash_to(&trash, &path).unwrap();
        let loaded = load_trash_from(&path);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "t1");
        assert_eq!(loaded[0].content, "deleted");
    }

    #[test]
    fn load_notes_nonexistent_returns_empty() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nonexistent.json");
        assert!(load_notes_from(&path).is_empty());
    }

    #[test]
    fn load_settings_nonexistent_returns_default() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nonexistent.json");
        let s = load_settings_from(&path);
        assert_eq!(s.default_color, "yellow");
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
    fn atomic_write_to_nonexistent_dir_returns_err() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("no_such_dir").join("file.json");
        let result = atomic_write(&path, "data");
        assert!(result.is_err());
    }

    // ── save_*_to error path tests ──

    #[test]
    fn save_notes_to_nonexistent_dir_returns_err() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("no_such_dir").join("notes.json");
        let notes = vec![make_note("e1", "yellow", "err")];
        let result = save_notes_to(&notes, &path);
        assert!(result.is_err());
    }

    #[test]
    fn save_settings_to_nonexistent_dir_returns_err() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("no_such_dir").join("settings.json");
        let result = save_settings_to(&Settings::default(), &path);
        assert!(result.is_err());
    }

    #[test]
    fn save_trash_to_nonexistent_dir_returns_err() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("no_such_dir").join("trash.json");
        let trash = vec![make_note("t1", "green", "err")];
        let result = save_trash_to(&trash, &path);
        assert!(result.is_err());
    }
}
