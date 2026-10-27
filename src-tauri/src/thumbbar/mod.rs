//! Media buttons in the taskbar thumbnail preview (Windows): like, previous, play/pause and next
//! below the window preview. The frontend sends the player state and the tooltips in the app
//! language (`thumbbar_update`); clicks come back as `thumbbar-click` events and run the same
//! actions as the player bar. Other platforms have no such toolbar; the commands do nothing there.

// Only the Windows side uses the button and glyph logic; elsewhere it is just compiled and tested.
#![cfg_attr(not(windows), allow(dead_code))]

mod glyphs;
#[cfg(windows)]
mod win;

use glyphs::Glyph;
use serde::{Deserialize, Serialize};

/// Event sent to the frontend when a button is clicked.
const CLICK_EVENT: &str = "thumbbar-click";
/// Command id of the first button (`WM_COMMAND`); the others follow.
const FIRST_ID: u32 = 0x7A00;
/// Tooltip buffer of a thumbnail button, including the terminating NUL.
const TIP_LEN: usize = 260;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbLabels {
    like: String,
    unlike: String,
    play: String,
    pause: String,
    previous: String,
    next: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbState {
    playing: bool,
    liked: bool,
    can_like: bool,
    can_toggle: bool,
    has_previous: bool,
    has_next: bool,
    labels: ThumbLabels,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Button {
    Like,
    Previous,
    Toggle,
    Next,
}

impl Button {
    const ALL: [Self; 4] = [Self::Like, Self::Previous, Self::Toggle, Self::Next];

    fn id(self) -> u32 {
        FIRST_ID + self as u32
    }

    fn from_id(id: u32) -> Option<Self> {
        Self::ALL.into_iter().find(|b| b.id() == id)
    }

    /// Name in the click event.
    fn name(self) -> &'static str {
        match self {
            Self::Like => "like",
            Self::Previous => "previous",
            Self::Toggle => "toggle",
            Self::Next => "next",
        }
    }

    fn glyph(self, playing: bool, liked: bool) -> Glyph {
        match self {
            Self::Like if liked => Glyph::HeartFilled,
            Self::Like => Glyph::Heart,
            Self::Previous => Glyph::SkipBack,
            Self::Toggle if playing => Glyph::Pause,
            Self::Toggle => Glyph::Play,
            Self::Next => Glyph::SkipForward,
        }
    }
}

#[derive(Clone, Serialize)]
struct Click {
    button: &'static str,
}

/// How a button looks for a state.
#[derive(Debug, PartialEq)]
struct ButtonView<'a> {
    button: Button,
    glyph: Glyph,
    tooltip: &'a str,
    enabled: bool,
    hidden: bool,
}

/// The buttons for a state; without one (no player, e.g. signed out) they are hidden.
fn button_views(state: Option<&ThumbState>) -> [ButtonView<'_>; 4] {
    Button::ALL.map(|button| {
        let Some(s) = state else {
            return ButtonView {
                button,
                glyph: button.glyph(false, false),
                tooltip: "",
                enabled: false,
                hidden: true,
            };
        };
        let labels = &s.labels;
        let (tooltip, enabled) = match button {
            Button::Like if s.liked => (&labels.unlike, s.can_like),
            Button::Like => (&labels.like, s.can_like),
            Button::Previous => (&labels.previous, s.has_previous),
            Button::Toggle if s.playing => (&labels.pause, s.can_toggle),
            Button::Toggle => (&labels.play, s.can_toggle),
            Button::Next => (&labels.next, s.has_next),
        };
        ButtonView {
            button,
            glyph: button.glyph(s.playing, s.liked),
            tooltip,
            enabled,
            hidden: false,
        }
    })
}

/// A tooltip as a NUL-terminated UTF-16 buffer, cut to fit without splitting a surrogate pair.
fn tooltip_utf16(text: &str) -> [u16; TIP_LEN] {
    let mut buffer = [0; TIP_LEN];
    let mut len = 0;
    for c in text.chars() {
        let mut units = [0; 2];
        let units = c.encode_utf16(&mut units);
        if len + units.len() >= TIP_LEN {
            break;
        }
        buffer[len..len + units.len()].copy_from_slice(units);
        len += units.len();
    }
    buffer
}

/// Puts the buttons on the main window's taskbar button once it exists (Windows).
pub fn init(app: &tauri::AppHandle) {
    #[cfg(windows)]
    win::attach(app);
    #[cfg(not(windows))]
    let _ = app;
}

/// New player state or texts for the buttons.
#[tauri::command]
pub fn thumbbar_update(app: tauri::AppHandle, state: ThumbState) {
    #[cfg(windows)]
    win::set_state(&app, Some(state));
    #[cfg(not(windows))]
    let _ = (app, state);
}

/// No player any more (signed out): hides the buttons.
#[tauri::command]
pub fn thumbbar_clear(app: tauri::AppHandle) {
    #[cfg(windows)]
    win::set_state(&app, None);
    #[cfg(not(windows))]
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(json: serde_json::Value) -> ThumbState {
        serde_json::from_value(json).unwrap()
    }

    fn sample(playing: bool, liked: bool) -> ThumbState {
        state(serde_json::json!({
            "playing": playing,
            "liked": liked,
            "canLike": true,
            "canToggle": true,
            "hasPrevious": true,
            "hasNext": false,
            "labels": {
                "like": "Add to favorites",
                "unlike": "Remove from favorites",
                "play": "Play",
                "pause": "Pause",
                "previous": "Previous",
                "next": "Next",
            },
        }))
    }

    #[test]
    fn button_ids_round_trip() {
        for button in Button::ALL {
            assert_eq!(Button::from_id(button.id()), Some(button));
            assert!(button.id() <= 0xFFFF, "fits the low word of WM_COMMAND");
        }
        assert_eq!(Button::from_id(FIRST_ID + 4), None);
        assert_eq!(Button::from_id(0), None);
        let names: Vec<_> = Button::ALL.iter().map(|b| b.name()).collect();
        assert_eq!(names, ["like", "previous", "toggle", "next"]);
    }

    #[test]
    fn hidden_without_state() {
        for view in button_views(None) {
            assert!(view.hidden && !view.enabled);
        }
    }

    #[test]
    fn views_follow_play_and_favorite_state() {
        let paused = sample(false, false);
        let [like, previous, toggle, next] = button_views(Some(&paused));
        assert_eq!((like.glyph, like.tooltip), (Glyph::Heart, "Add to favorites"));
        assert_eq!((previous.glyph, previous.tooltip), (Glyph::SkipBack, "Previous"));
        assert_eq!((toggle.glyph, toggle.tooltip), (Glyph::Play, "Play"));
        assert_eq!((next.glyph, next.tooltip), (Glyph::SkipForward, "Next"));
        assert!(like.enabled && previous.enabled && toggle.enabled);
        assert!(!next.enabled && !next.hidden);

        let playing = sample(true, true);
        let [like, _, toggle, _] = button_views(Some(&playing));
        assert_eq!((like.glyph, like.tooltip), (Glyph::HeartFilled, "Remove from favorites"));
        assert_eq!((toggle.glyph, toggle.tooltip), (Glyph::Pause, "Pause"));
    }

    #[test]
    fn nothing_loaded_disables_everything() {
        let idle = state(serde_json::json!({
            "playing": false, "liked": false, "canLike": false, "canToggle": false,
            "hasPrevious": false, "hasNext": false,
            "labels": { "like": "", "unlike": "", "play": "", "pause": "", "previous": "", "next": "" },
        }));
        for view in button_views(Some(&idle)) {
            assert!(!view.enabled && !view.hidden);
        }
    }

    #[test]
    fn tooltips_are_nul_terminated_and_cut() {
        let tip = tooltip_utf16("Nächster");
        let expected: Vec<u16> = "Nächster".encode_utf16().collect();
        assert_eq!(&tip[..expected.len()], expected.as_slice());
        assert_eq!(tip[expected.len()], 0);

        let long = "x".repeat(400);
        let tip = tooltip_utf16(&long);
        assert_eq!(tip[TIP_LEN - 2], u16::from(b'x'));
        assert_eq!(tip[TIP_LEN - 1], 0);

        // A character outside the BMP that would not fit whole is left out.
        let edge = format!("{}🎵", "x".repeat(TIP_LEN - 2));
        let tip = tooltip_utf16(&edge);
        assert_eq!(tip[TIP_LEN - 2], 0);
    }
}
