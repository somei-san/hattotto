use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{
    menu::{IconMenuItem, Menu, MenuItem, NativeIcon, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_autostart::MacosLauncher;
use uuid::Uuid;

// ── Data Model ──────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Note {
    pub id: String,
    pub content: String,
    pub color: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default = "default_zoom")]
    pub zoom: u32,
}

fn default_zoom() -> u32 {
    100
}

impl Note {
    fn new(color: &str) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            content: String::new(),
            color: color.into(),
            x: 120.0,
            y: 120.0,
            width: 280.0,
            height: 320.0,
            zoom: 100,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Settings {
    pub default_color: String,
    pub font_size: u32,
    pub zoom: u32,
    pub opacity: u32,
    #[serde(default)]
    pub edit_on_single_click: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            default_color: "yellow".into(),
            font_size: 14,
            zoom: 100,
            opacity: 100,
            edit_on_single_click: false,
        }
    }
}

const TRASH_MAX: usize = 20;

pub struct AppState {
    notes: Mutex<Vec<Note>>,
    settings: Mutex<Settings>,
    trash: Mutex<Vec<Note>>,
    bringing_to_front: AtomicBool,
}

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

fn load_notes_from(path: &Path) -> Vec<Note> {
    if path.exists() {
        fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        vec![]
    }
}

fn load_notes() -> Vec<Note> {
    load_notes_from(&data_file())
}

fn save_notes_to(notes: &[Note], path: &Path) {
    if let Ok(json) = serde_json::to_string_pretty(notes) {
        let _ = fs::write(path, json);
    }
}

fn save_notes(notes: &[Note]) {
    save_notes_to(notes, &data_file());
}

fn load_settings_from(path: &Path) -> Settings {
    if path.exists() {
        fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        Settings::default()
    }
}

fn load_settings() -> Settings {
    load_settings_from(&settings_file())
}

fn save_settings_to(settings: &Settings, path: &Path) {
    if let Ok(json) = serde_json::to_string_pretty(settings) {
        let _ = fs::write(path, json);
    }
}

fn save_settings(settings: &Settings) {
    save_settings_to(settings, &settings_file());
}

fn trash_file() -> PathBuf {
    data_dir().join("trash.json")
}

fn load_trash_from(path: &Path) -> Vec<Note> {
    if path.exists() {
        fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        vec![]
    }
}

fn load_trash() -> Vec<Note> {
    load_trash_from(&trash_file())
}

fn save_trash_to(trash: &[Note], path: &Path) {
    if let Ok(json) = serde_json::to_string_pretty(trash) {
        let _ = fs::write(path, json);
    }
}

fn save_trash(trash: &[Note]) {
    save_trash_to(trash, &trash_file());
}

/// ゴミ箱のFIFO制限: TRASH_MAXを超えた分を先頭から削除
fn enforce_trash_limit(trash: &mut Vec<Note>) {
    let overflow = trash.len().saturating_sub(TRASH_MAX);
    if overflow > 0 {
        trash.drain(0..overflow);
    }
}

// ── Tauri Commands ──────────────────────────────────────────

#[tauri::command]
fn get_note(id: String, state: State<AppState>) -> Option<Note> {
    let notes = state.notes.lock().unwrap();
    notes.iter().find(|n| n.id == id).cloned()
}

#[tauri::command]
fn update_note_content(id: String, content: String, state: State<AppState>) {
    let mut notes = state.notes.lock().unwrap();
    if let Some(note) = notes.iter_mut().find(|n| n.id == id) {
        note.content = content;
    }
    save_notes(&notes);
}

#[tauri::command]
fn update_note_color(id: String, color: String, state: State<AppState>) {
    let mut notes = state.notes.lock().unwrap();
    if let Some(note) = notes.iter_mut().find(|n| n.id == id) {
        note.color = color;
    }
    save_notes(&notes);
}

#[tauri::command]
fn update_note_geometry(
    id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    state: State<AppState>,
) {
    let mut notes = state.notes.lock().unwrap();
    if let Some(note) = notes.iter_mut().find(|n| n.id == id) {
        note.x = x;
        note.y = y;
        note.width = width;
        note.height = height;
    }
    save_notes(&notes);
}

#[tauri::command]
fn update_note_zoom(id: String, zoom: u32, state: State<AppState>) {
    let mut notes = state.notes.lock().unwrap();
    if let Some(note) = notes.iter_mut().find(|n| n.id == id) {
        note.zoom = zoom.clamp(50, 200);
    }
    save_notes(&notes);
}

#[tauri::command]
fn delete_note(id: String, app: AppHandle, state: State<AppState>) {
    {
        let mut notes = state.notes.lock().unwrap();
        if let Some(pos) = notes.iter().position(|n| n.id == id) {
            let note = notes.remove(pos);
            save_notes(&notes);
            let mut trash = state.trash.lock().unwrap();
            trash.push(note);
            enforce_trash_limit(&mut trash);
            save_trash(&trash);
        }
    }
    if let Some(win) = app.get_webview_window(&format!("note-{}", id)) {
        let _ = win.close();
    }
}

#[tauri::command]
fn get_trash(state: State<AppState>) -> Vec<Note> {
    state.trash.lock().unwrap().clone()
}

#[tauri::command]
fn restore_note(id: String, app: AppHandle, state: State<AppState>) -> Option<Note> {
    let note = {
        let mut trash = state.trash.lock().unwrap();
        if let Some(pos) = trash.iter().position(|n| n.id == id) {
            let note = trash.remove(pos);
            save_trash(&trash);
            Some(note)
        } else {
            None
        }
    };
    if let Some(note) = note {
        open_note_window(&app, &note);
        let mut notes = state.notes.lock().unwrap();
        notes.push(note.clone());
        save_notes(&notes);
        Some(note)
    } else {
        None
    }
}

#[tauri::command]
fn empty_trash(state: State<AppState>) {
    let mut trash = state.trash.lock().unwrap();
    trash.clear();
    save_trash(&trash);
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn update_settings(
    default_color: String,
    font_size: u32,
    zoom: u32,
    opacity: u32,
    edit_on_single_click: bool,
    state: State<AppState>,
) {
    let mut settings = state.settings.lock().unwrap();
    settings.default_color = default_color;
    settings.font_size = font_size;
    settings.zoom = zoom.clamp(50, 200);
    settings.opacity = opacity.clamp(20, 100);
    settings.edit_on_single_click = edit_on_single_click;
    save_settings(&settings);
}

#[tauri::command]
fn open_settings(app: AppHandle) {
    open_settings_window(&app);
}

#[tauri::command]
fn open_trash(app: AppHandle) {
    open_trash_window(&app);
}

#[tauri::command]
fn create_note(app: AppHandle, state: State<AppState>) -> Note {
    let default_color = {
        let settings = state.settings.lock().unwrap();
        settings.default_color.clone()
    };
    let note = Note::new(&default_color);
    {
        let mut notes = state.notes.lock().unwrap();
        // Offset new note position so it doesn't stack exactly
        let offset = (notes.len() as f64) * 30.0;
        let mut n = note.clone();
        n.x += offset;
        n.y += offset;
        open_note_window(&app, &n);
        notes.push(n.clone());
        save_notes(&notes);
        n
    }
}

// ── Window Management ───────────────────────────────────────

fn open_note_window(app: &AppHandle, note: &Note) {
    let label = format!("note-{}", note.id);
    let url = format!("note.html?id={}", note.id);

    let _ = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title("") // No title for Stickies-like feel
        .inner_size(note.width, note.height)
        .min_inner_size(200.0, 150.0)
        .position(note.x, note.y)
        .decorations(false)
        .transparent(true)
        .always_on_top(false)
        .visible(true)
        .build();
}

// ── Window Management (Settings) ────────────────────────────

fn open_settings_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title("Hatto-to — 設定 / ヘルプ")
        .inner_size(420.0, 520.0)
        .min_inner_size(380.0, 460.0)
        .resizable(true)
        .visible(true)
        .build();
}

fn open_trash_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("trash") {
        let _ = win.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "trash", WebviewUrl::App("trash.html".into()))
        .title("ゴミ箱")
        .inner_size(360.0, 480.0)
        .min_inner_size(300.0, 300.0)
        .resizable(true)
        .visible(true)
        .build();
}

// ── App Menu ────────────────────────────────────────────────

fn setup_app_menu(app: &AppHandle) -> tauri::Result<()> {
    let settings_item = MenuItem::with_id(
        app,
        "open_settings",
        "Settings...",
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let new_note_item = IconMenuItem::with_id_and_native_icon(
        app,
        "new_note",
        "New Note",
        true,
        Some(NativeIcon::Add),
        Some("CmdOrCtrl+N"),
    )?;

    let app_submenu = Submenu::with_items(
        app,
        "Hatto-to",
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
        "Trash...",
        true,
        Some(NativeIcon::TrashEmpty),
        Some("CmdOrCtrl+Shift+T"),
    )?;

    let file_submenu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &new_note_item,
            &PredefinedMenuItem::separator(app)?,
            &trash_item,
        ],
    )?;

    let edit_submenu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let zoom_in_item = MenuItem::with_id(app, "zoom_in", "Zoom In", true, Some("CmdOrCtrl+="))?;
    let zoom_out_item = MenuItem::with_id(app, "zoom_out", "Zoom Out", true, Some("CmdOrCtrl+-"))?;
    let zoom_reset_item =
        MenuItem::with_id(app, "zoom_reset", "Actual Size", true, Some("CmdOrCtrl+0"))?;
    let view_submenu = Submenu::with_items(
        app,
        "View",
        true,
        &[&zoom_in_item, &zoom_out_item, &zoom_reset_item],
    )?;

    let menu = Menu::with_items(
        app,
        &[&app_submenu, &file_submenu, &edit_submenu, &view_submenu],
    )?;
    app.set_menu(menu)?;

    app.on_menu_event(|app, event| match event.id().as_ref() {
        "open_settings" => {
            open_settings_window(app);
        }
        "new_note" => {
            let state: State<AppState> = app.state();
            let default_color = state.settings.lock().unwrap().default_color.clone();
            let note = Note::new(&default_color);
            let mut notes = state.notes.lock().unwrap();
            let offset = (notes.len() as f64) * 30.0;
            let mut n = note;
            n.x += offset;
            n.y += offset;
            open_note_window(app, &n);
            notes.push(n);
            save_notes(&notes);
        }
        "open_trash" => {
            open_trash_window(app);
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
        _ => {}
    });

    Ok(())
}

// ── System Tray ─────────────────────────────────────────────

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
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
        .tooltip("Hatto-to")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray_new_note" => {
                let state: State<AppState> = app.state();
                let default_color = state.settings.lock().unwrap().default_color.clone();
                let note = Note::new(&default_color);
                let mut notes = state.notes.lock().unwrap();
                let offset = (notes.len() as f64) * 30.0;
                let mut n = note;
                n.x += offset;
                n.y += offset;
                open_note_window(app, &n);
                notes.push(n);
                save_notes(&notes);
            }
            "settings" => {
                open_settings_window(app);
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}

// ── Bring All Notes to Front ────────────────────────────────

fn bring_all_to_front(app: &AppHandle) {
    let state: State<AppState> = app.state();
    let notes = state.notes.lock().unwrap();
    for note in notes.iter() {
        if let Some(win) = app.get_webview_window(&format!("note-{}", note.id)) {
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

/// AtomicBool を RAII で管理し、パニック時にも確実にフラグをリセットする
struct BringToFrontGuard<'a>(&'a AtomicBool);
impl Drop for BringToFrontGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// 1つの付箋がフォーカスされたとき、他の全付箋ウィンドウも前面に表示する（フォーカスは奪わない）
fn show_all_note_windows(app: &AppHandle, focused_label: &str) {
    let state: State<AppState> = app.state();

    // 再入防止: 他ウィンドウの show が再度 focus イベントを発火した場合のガード
    if state.bringing_to_front.swap(true, Ordering::Acquire) {
        return;
    }
    let _guard = BringToFrontGuard(&state.bringing_to_front);

    // ロック内でラベル一覧だけ収集し、ロックを解放してから show() を呼ぶ
    let labels: Vec<String> = {
        let notes = state
            .notes
            .lock()
            .expect("notes lock poisoned in show_all_note_windows");
        notes.iter().map(|n| format!("note-{}", n.id)).collect()
    };
    for label in labels {
        if label == focused_label {
            continue;
        }
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.show();
        }
    }
}

// ── App Entry ───────────────────────────────────────────────

pub fn run() {
    let notes = load_notes();
    let settings = load_settings();
    let trash = load_trash();
    let state = AppState {
        notes: Mutex::new(notes),
        settings: Mutex::new(settings),
        trash: Mutex::new(trash),
        bringing_to_front: AtomicBool::new(false),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_shell::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_note,
            update_note_content,
            update_note_color,
            update_note_geometry,
            update_note_zoom,
            delete_note,
            create_note,
            get_settings,
            update_settings,
            open_settings,
            get_trash,
            restore_note,
            empty_trash,
            open_trash,
        ])
        .setup(|app| {
            // Set up app menu and system tray
            let _ = setup_app_menu(app.handle());
            let _ = setup_tray(app.handle());

            // Restore saved notes
            let state: State<AppState> = app.state();
            let notes = state.notes.lock().unwrap().clone();

            if notes.is_empty() {
                // Create a default note on first launch
                drop(notes);
                let default_color = {
                    let state: State<AppState> = app.state();
                    let color = state.settings.lock().unwrap().default_color.clone();
                    color
                };
                let note = Note::new(&default_color);
                open_note_window(app.handle(), &note);
                let state: State<AppState> = app.state();
                let mut notes = state.notes.lock().unwrap();
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
        .run(|app, event| match event {
            tauri::RunEvent::Reopen { .. } => {
                bring_all_to_front(app);
            }
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Focused(true),
                ..
            } if label.starts_with("note-") => {
                show_all_note_windows(app, &label);
            }
            _ => {}
        });
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
        }
    }

    // ── Note::new() ──

    #[test]
    fn note_new_has_uuid_format() {
        let note = Note::new("yellow");
        assert!(uuid::Uuid::parse_str(&note.id).is_ok());
    }

    #[test]
    fn note_new_defaults() {
        let note = Note::new("blue");
        assert_eq!(note.content, "");
        assert_eq!(note.color, "blue");
        assert_eq!(note.x, 120.0);
        assert_eq!(note.y, 120.0);
        assert_eq!(note.width, 280.0);
        assert_eq!(note.height, 320.0);
        assert_eq!(note.zoom, 100);
    }

    #[test]
    fn note_new_color_reflected() {
        assert_eq!(Note::new("pink").color, "pink");
        assert_eq!(Note::new("green").color, "green");
    }

    // ── Settings::default() ──

    #[test]
    fn settings_default_values() {
        let s = Settings::default();
        assert_eq!(s.default_color, "yellow");
        assert_eq!(s.font_size, 14);
        assert_eq!(s.zoom, 100);
        assert_eq!(s.opacity, 100);
        assert!(!s.edit_on_single_click);
    }

    // ── Trash FIFO ──

    #[test]
    fn trash_fifo_within_limit() {
        let mut trash: Vec<Note> = (0..20)
            .map(|i| make_note(&i.to_string(), "yellow", ""))
            .collect();
        enforce_trash_limit(&mut trash);
        assert_eq!(trash.len(), 20);
    }

    #[test]
    fn trash_fifo_overflow_by_one() {
        let mut trash: Vec<Note> = (0..21)
            .map(|i| make_note(&i.to_string(), "yellow", ""))
            .collect();
        enforce_trash_limit(&mut trash);
        assert_eq!(trash.len(), 20);
        // oldest (id "0") should be removed
        assert_eq!(trash[0].id, "1");
    }

    #[test]
    fn trash_fifo_overflow_by_five() {
        let mut trash: Vec<Note> = (0..25)
            .map(|i| make_note(&i.to_string(), "yellow", ""))
            .collect();
        enforce_trash_limit(&mut trash);
        assert_eq!(trash.len(), 20);
        assert_eq!(trash[0].id, "5");
        assert_eq!(trash[19].id, "24");
    }

    // ── Zoom clamp ──

    #[test]
    fn zoom_clamp_below_min() {
        assert_eq!(30_u32.clamp(50, 200), 50);
    }

    #[test]
    fn zoom_clamp_above_max() {
        assert_eq!(250_u32.clamp(50, 200), 200);
    }

    #[test]
    fn zoom_clamp_within_range() {
        assert_eq!(120_u32.clamp(50, 200), 120);
    }

    // ── Opacity clamp ──

    #[test]
    fn opacity_clamp_below_min() {
        assert_eq!(10_u32.clamp(20, 100), 20);
    }

    #[test]
    fn opacity_clamp_above_max() {
        assert_eq!(150_u32.clamp(20, 100), 100);
    }

    #[test]
    fn opacity_clamp_within_range() {
        assert_eq!(75_u32.clamp(20, 100), 75);
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
        save_notes_to(&notes, &path);
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
        };
        save_settings_to(&settings, &path);
        let loaded = load_settings_from(&path);
        assert_eq!(loaded.default_color, "pink");
        assert_eq!(loaded.font_size, 18);
        assert_eq!(loaded.zoom, 150);
        assert_eq!(loaded.opacity, 80);
        assert!(loaded.edit_on_single_click);
    }

    #[test]
    fn trash_roundtrip() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("trash.json");
        let trash = vec![make_note("t1", "green", "deleted")];
        save_trash_to(&trash, &path);
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

    // ── Note serde backward compat (missing zoom field) ──

    #[test]
    fn note_deserialize_without_zoom_defaults_to_100() {
        let json = r#"{"id":"old","content":"text","color":"yellow","x":0,"y":0,"width":280,"height":320}"#;
        let note: Note = serde_json::from_str(json).unwrap();
        assert_eq!(note.zoom, 100);
    }
}
