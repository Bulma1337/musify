//! Moves the data of the app from before its rename (Navify → Musify) to the new folders, once.
//!
//! The app identifier names the data folders (settings, database, WebView storage, downloads,
//! cache). Moving the folders keeps sign-ins, settings, the queue, downloads and the listening
//! history. It runs before any window or plugin opens a file in them.

/// Must match `identifier` in tauri.conf.json.
pub const IDENTIFIER: &str = "io.github.bulma1337.musify";
const OLD_IDENTIFIER: &str = "io.github.bulma1337.navify";

pub fn move_old_data() {
    #[cfg(windows)]
    for var in ["APPDATA", "LOCALAPPDATA"] {
        let Some(base) = std::env::var_os(var).map(std::path::PathBuf::from) else {
            continue;
        };
        let old = base.join(OLD_IDENTIFIER);
        let new = base.join(IDENTIFIER);
        if old.is_dir() && !new.exists() {
            // Same volume: a rename is instant, also for many gigabytes of downloads.
            if let Err(e) = std::fs::rename(&old, &new) {
                eprintln!("could not move {} to {}: {e}", old.display(), new.display());
            }
        }
    }
}
