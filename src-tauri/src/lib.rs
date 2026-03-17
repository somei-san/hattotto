use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{
    image::Image,
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
    fn new() -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            content: String::new(),
            color: "yellow".into(),
            x: 120.0,
            y: 120.0,
            width: 280.0,
            height: 320.0,
        }
    }
}

pub struct AppState {
    notes: Mutex<Vec<Note>>,
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
fn create_note(app: AppHandle, state: State<AppState>) -> Note {
    let note = Note::new();
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
        return n;
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

// ── System Tray ─────────────────────────────────────────────

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let new_note = MenuItem::with_id(app, "new_note", "New Note", true, Some("CmdOrCtrl+N"))?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, Some("CmdOrCtrl+Q"))?;
    let menu = Menu::with_items(app, &[&new_note, &quit])?;

    // Use a simple 1x1 pixel icon as fallback (you can replace with a real icon)
    let icon = Image::from_bytes(include_bytes!("../icons/tray.png"))
        .unwrap_or_else(|_| Image::new(&[255, 255, 0, 255], 1, 1));

    TrayIconBuilder::new()
        .icon(icon)
        .icon_as_template(true)
        .menu(&menu)
        .tooltip("Hatto-to")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "new_note" => {
                let state: State<AppState> = app.state();
                let note = Note::new();
                let mut notes = state.notes.lock().unwrap();
                let offset = (notes.len() as f64) * 30.0;
                let mut n = note;
                n.x += offset;
                n.y += offset;
                open_note_window(app, &n);
                notes.push(n);
                save_notes(&notes);
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
    let state = AppState {
        notes: Mutex::new(notes),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_note,
            update_note_content,
            update_note_color,
            update_note_geometry,
            delete_note,
            create_note,
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
                let note = Note::new();
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
