use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::Instant;
use uuid::Uuid;

// ── Data Model ──────────────────────────────────────────────

pub(crate) const TRASH_MAX: usize = 200;

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
    #[serde(default)]
    pub pinned: bool,
}

fn default_zoom() -> u32 {
    100
}

impl Note {
    pub(crate) fn new(color: &str) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            content: String::new(),
            color: color.into(),
            x: 120.0,
            y: 120.0,
            width: 280.0,
            height: 320.0,
            zoom: 100,
            pinned: false,
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
    #[serde(default = "default_true")]
    pub bring_all_to_front: bool,
    #[serde(default = "default_true")]
    pub show_pin_button: bool,
    #[serde(default = "default_true")]
    pub show_new_button: bool,
    #[serde(default = "default_true")]
    pub show_color_button: bool,
    #[serde(default = "default_true")]
    pub confirm_before_delete: bool,
}

fn default_true() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            default_color: "yellow".into(),
            font_size: 14,
            zoom: 100,
            opacity: 100,
            edit_on_single_click: false,
            bring_all_to_front: true,
            show_pin_button: true,
            show_new_button: true,
            show_color_button: true,
            confirm_before_delete: true,
        }
    }
}

pub struct AppState {
    pub(crate) notes: Mutex<Vec<Note>>,
    pub(crate) settings: Mutex<Settings>,
    pub(crate) trash: Mutex<Vec<Note>>,
    pub(crate) last_bring_to_front: Mutex<Instant>,
    /// Note ID that last opened the context menu (for routing menu events)
    pub(crate) context_menu_note_id: Mutex<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(!note.pinned);
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
        assert!(s.bring_all_to_front);
        assert!(s.show_pin_button);
        assert!(s.show_new_button);
        assert!(s.show_color_button);
        assert!(s.confirm_before_delete);
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

    // ── Note serde backward compat (missing zoom field) ──

    #[test]
    fn note_deserialize_without_zoom_defaults_to_100() {
        let json = r#"{"id":"old","content":"text","color":"yellow","x":0,"y":0,"width":280,"height":320}"#;
        let note: Note = serde_json::from_str(json).unwrap();
        assert_eq!(note.zoom, 100);
    }

    // ── Note::new() UUID format ──

    #[test]
    fn note_new_id_is_valid_uuid_v4() {
        let note = Note::new("blue");
        let parsed = uuid::Uuid::parse_str(&note.id).expect("should be valid UUID");
        assert_eq!(parsed.get_version(), Some(uuid::Version::Random));
    }

    // ── Settings default field-level checks ──

    #[test]
    fn settings_default_boolean_fields() {
        let s = Settings::default();
        assert!(!s.edit_on_single_click);
        assert!(s.bring_all_to_front);
        assert!(s.show_pin_button);
        assert!(s.show_new_button);
        assert!(s.show_color_button);
    }

    #[test]
    fn settings_default_numeric_fields() {
        let s = Settings::default();
        assert_eq!(s.font_size, 14);
        assert_eq!(s.zoom, 100);
        assert_eq!(s.opacity, 100);
    }

    // ── pinned field defaults ──

    #[test]
    fn note_new_pinned_defaults_to_false() {
        let note = Note::new("pink");
        assert!(!note.pinned);
    }

    #[test]
    fn note_deserialize_without_pinned_defaults_to_false() {
        let json = r#"{"id":"old","content":"","color":"yellow","x":0,"y":0,"width":280,"height":320,"zoom":100}"#;
        let note: Note = serde_json::from_str(json).unwrap();
        assert!(!note.pinned);
    }

    // ── TRASH_MAX ──

    #[test]
    fn trash_max_is_200() {
        assert_eq!(TRASH_MAX, 200);
    }

    // ── confirm_before_delete ──

    #[test]
    fn settings_default_confirm_before_delete_is_true() {
        let s = Settings::default();
        assert!(s.confirm_before_delete);
    }

    #[test]
    fn settings_json_roundtrip_with_confirm_before_delete() {
        let mut s = Settings::default();
        s.confirm_before_delete = false;
        let json = serde_json::to_string(&s).unwrap();
        let loaded: Settings = serde_json::from_str(&json).unwrap();
        assert!(!loaded.confirm_before_delete);
    }

    #[test]
    fn settings_deserialize_without_confirm_before_delete_defaults_to_true() {
        let json = r#"{"default_color":"yellow","font_size":14,"zoom":100,"opacity":100}"#;
        let s: Settings = serde_json::from_str(json).unwrap();
        assert!(s.confirm_before_delete);
    }
}
