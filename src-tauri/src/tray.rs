//! Tray icon: a left click brings the window back; the menu offers open, play/pause, next,
//! previous and quit. Labels and the play/pause state come from the frontend (`tray_update`), which
//! also handles the actions: transport buttons arrive as `media-control` events like media keys,
//! "quit" as `app-quit` so the frontend can save the queue before the app exits.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

/// If the frontend does not close the app within this time after "quit", it exits anyway.
const QUIT_FALLBACK: Duration = Duration::from_secs(4);

pub struct TrayState {
    tray: TrayIcon,
    open: MenuItem<Wry>,
    toggle: MenuItem<Wry>,
    next: MenuItem<Wry>,
    previous: MenuItem<Wry>,
    quit: MenuItem<Wry>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "action", rename_all = "camelCase")]
enum Action {
    Toggle,
    Next,
    Previous,
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn create(app: &AppHandle) -> tauri::Result<TrayState> {
    let open = MenuItem::with_id(app, "open", "Musify öffnen", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "Wiedergabe", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "next", "Weiter", true, None::<&str>)?;
    let previous = MenuItem::with_id(app, "previous", "Zurück", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Beenden", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &toggle,
            &next,
            &previous,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Musify")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "toggle" => {
                let _ = app.emit("media-control", Action::Toggle);
            }
            "next" => {
                let _ = app.emit("media-control", Action::Next);
            }
            "previous" => {
                let _ = app.emit("media-control", Action::Previous);
            }
            "quit" => {
                let _ = app.emit("app-quit", ());
                let app = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(QUIT_FALLBACK);
                    app.exit(0);
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let tray = builder.build(app)?;
    Ok(TrayState {
        tray,
        open,
        toggle,
        next,
        previous,
        quit,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayLabels {
    open: String,
    play: String,
    pause: String,
    next: String,
    previous: String,
    quit: String,
}

/// Menu texts in the app language, the play/pause label and the tooltip (current track).
#[tauri::command]
pub fn tray_update(
    state: tauri::State<'_, TrayState>,
    labels: TrayLabels,
    playing: bool,
    has_track: bool,
    tooltip: String,
) {
    let _ = state.open.set_text(&labels.open);
    let _ = state
        .toggle
        .set_text(if playing { &labels.pause } else { &labels.play });
    let _ = state.toggle.set_enabled(has_track);
    let _ = state.next.set_enabled(has_track);
    let _ = state.previous.set_enabled(has_track);
    let _ = state.next.set_text(&labels.next);
    let _ = state.previous.set_text(&labels.previous);
    let _ = state.quit.set_text(&labels.quit);
    let _ = state.tray.set_tooltip(Some(&tooltip));
}
