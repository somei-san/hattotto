use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri_plugin_autostart::MacosLauncher;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder,
};
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
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Settings {
    pub default_color: String,
    pub font_size: u32,
    pub zoom: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            default_color: "yellow".into(),
            font_size: 14,
            zoom: 100,
        }
    }
}

pub struct AppState {
    notes: Mutex<Vec<Note>>,
    settings: Mutex<Settings>,
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

fn load_notes() -> Vec<Note> {
    let path = data_file();
    if path.exists() {
        fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        vec![]
    }
}

fn save_notes(notes: &[Note]) {
    let path = data_file();
    if let Ok(json) = serde_json::to_string_pretty(notes) {
        let _ = fs::write(path, json);
    }
}

fn load_settings() -> Settings {
    let path = settings_file();
    if path.exists() {
        fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        Settings::default()
    }
}

fn save_settings(settings: &Settings) {
    let path = settings_file();
    if let Ok(json) = serde_json::to_string_pretty(settings) {
        let _ = fs::write(path, json);
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
fn update_note_geometry(id: String, x: f64, y: f64, width: f64, height: f64, state: State<AppState>) {
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
fn delete_note(id: String, app: AppHandle, state: State<AppState>) {
    {
        let mut notes = state.notes.lock().unwrap();
        notes.retain(|n| n.id != id);
        save_notes(&notes);
    }
    if let Some(win) = app.get_webview_window(&format!("note-{}", id)) {
        let _ = win.close();
    }
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn update_settings(default_color: String, font_size: u32, zoom: u32, state: State<AppState>) {
    let mut settings = state.settings.lock().unwrap();
    settings.default_color = default_color;
    settings.font_size = font_size;
    settings.zoom = zoom.clamp(50, 200);
    save_settings(&settings);
}

#[tauri::command]
fn open_settings(app: AppHandle) {
    open_settings_window(&app);
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

// ── System Tray ─────────────────────────────────────────────

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let new_note = MenuItem::with_id(app, "new_note", "New Note", true, Some("CmdOrCtrl+N"))?;
    let settings = MenuItem::with_id(app, "settings", "Settings / Help", true, Some("CmdOrCtrl+,"))?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, Some("CmdOrCtrl+Q"))?;
    let menu = Menu::with_items(app, &[&new_note, &settings, &quit])?;

    let icon = tauri::include_image!("icons/tray.png");

    TrayIconBuilder::new()
        .icon(icon)
        .icon_as_template(true)
        .menu(&menu)
        .tooltip("Hatto-to")
        .on_menu_event(|app, event| match event.id().as_ref() {
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

// ── App Entry ───────────────────────────────────────────────

pub fn run() {
    let notes = load_notes();
    let settings = load_settings();
    let state = AppState {
        notes: Mutex::new(notes),
        settings: Mutex::new(settings),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_shell::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_note,
            update_note_content,
            update_note_color,
            update_note_geometry,
            delete_note,
            create_note,
            get_settings,
            update_settings,
            open_settings,
        ])
        .setup(|app| {
            // Set up system tray
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
        .run(tauri::generate_context!())
        .expect("error while running Hatto-to");
}
