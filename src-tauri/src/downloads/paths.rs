//! File layout of the downloads folder: `<server>/<album artist>/<album>/<disc-track> <title>.<ext>`.
//!
//! Names are made safe for Windows (the strictest of the supported systems) on every platform, so a
//! downloads folder can be moved between systems: invalid characters, reserved device names,
//! trailing dots and spaces, and over-long paths are all handled here.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};

/// Longest single path component we create (in characters).
const MAX_COMPONENT: usize = 100;
/// Longest full path (folder + relative path) we create. Windows' classic limit is 260 including
/// the terminating NUL; the margin leaves room for ` (2)` suffixes and the `.part` names.
const MAX_PATH: usize = 240;
/// Components are never shortened below this (unless the path would otherwise be too long).
const MIN_COMPONENT: usize = 8;

const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9", "CONIN$",
    "CONOUT$",
];

/// What the file layout is built from (sent by the frontend, never read from the file).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TrackLayout {
    pub server_name: String,
    pub album_artist: String,
    pub album: String,
    pub title: String,
    pub disc_number: Option<u32>,
    pub track_number: Option<u32>,
    /// Number of discs of the album, if known; a disc prefix is added for multi-disc releases.
    pub disc_total: Option<u32>,
}

/// Makes `name` usable as one file or folder name on Windows, macOS and Linux.
pub fn sanitize_component(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut last_space = false;
    for ch in name.chars() {
        let ch = match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => ' ',
            // Zero-width and bidirectional marks only cause confusion in file names.
            '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2066}'..='\u{2069}'
            | '\u{FEFF}' => {
                continue;
            }
            c => c,
        };
        if ch.is_whitespace() {
            if !last_space {
                out.push(' ');
            }
            last_space = true;
        } else {
            out.push(ch);
            last_space = false;
        }
    }
    let mut out = truncate_chars(
        out.trim_matches(|c: char| c == ' ' || c == '.'),
        MAX_COMPONENT,
    );
    // Windows silently strips trailing dots and spaces, which would make names collide or vanish.
    out = out.trim_end_matches(['.', ' ']).to_string();
    if out.is_empty() {
        out.push('_');
    }
    // `CON`, `con.txt` and `COM1.flac` are device names, whatever the extension.
    let stem = out
        .split('.')
        .next()
        .unwrap_or(&out)
        .trim_end()
        .to_uppercase();
    if RESERVED.contains(&stem.as_str()) {
        out.insert(0, '_');
    }
    out
}

fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// File extension (without dot) made of safe characters only; `bin` when nothing usable is given.
pub fn clean_extension(ext: &str) -> String {
    let ext: String = ext
        .trim_start_matches('.')
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect::<String>()
        .to_lowercase();
    if ext.is_empty() { "bin".into() } else { ext }
}

/// `03`, `2-03` or just the title when there is no track number.
fn file_stem(layout: &TrackLayout) -> String {
    let title = if layout.title.trim().is_empty() {
        "Untitled"
    } else {
        layout.title.as_str()
    };
    let number = match (layout.disc_number, layout.track_number) {
        (Some(disc), Some(track)) if disc > 1 || layout.disc_total.unwrap_or(1) > 1 => {
            Some(format!("{disc}-{track:02}"))
        }
        (_, Some(track)) => Some(format!("{track:02}")),
        _ => None,
    };
    match number {
        Some(number) => format!("{number} {title}"),
        None => title.to_string(),
    }
}

/// Relative path of a track file for the given layout, shortened so that `base` joined with it stays
/// below the path limit.
pub fn relative_track_path(layout: &TrackLayout, ext: &str, base: &Path) -> PathBuf {
    let ext = clean_extension(ext);
    let or = |s: &str, fallback: &str| {
        if s.trim().is_empty() {
            fallback.to_string()
        } else {
            s.to_string()
        }
    };
    // Components, widest first to shrink: title, album, artist, server.
    let mut parts = [
        sanitize_component(&or(&layout.server_name, "Server")),
        sanitize_component(&or(&layout.album_artist, "Unknown Artist")),
        sanitize_component(&or(&layout.album, "Unknown Album")),
        sanitize_component(&file_stem(layout)),
    ];
    let base_len = base.to_string_lossy().chars().count();
    let total = |parts: &[String; 4]| {
        // base + separators (one per component) + components + ".ext"
        base_len + parts.iter().map(|p| p.chars().count() + 1).sum::<usize>() + 1 + ext.len()
    };
    // Shrink the longest component first, never below MIN_COMPONENT while others can still shrink.
    while total(&parts) > MAX_PATH {
        let Some((index, len)) = parts
            .iter()
            .enumerate()
            .map(|(i, p)| (i, p.chars().count()))
            .max_by_key(|&(_, len)| len)
        else {
            break;
        };
        if len <= MIN_COMPONENT {
            break;
        }
        let shrink = (total(&parts) - MAX_PATH).min(len - MIN_COMPONENT).max(1);
        let shorter = sanitize_component(&truncate_chars(&parts[index], len - shrink));
        if shorter.chars().count() >= len {
            break;
        }
        parts[index] = shorter;
    }
    let [server, artist, album, stem] = parts;
    PathBuf::from(server)
        .join(artist)
        .join(album)
        .join(format!("{stem}.{ext}"))
}

/// Returns `path`, or `path` with ` (2)`, ` (3)` … before the extension when it is taken.
pub fn unique_path(path: &Path, taken: impl Fn(&Path) -> bool) -> PathBuf {
    if !taken(path) {
        return path.to_path_buf();
    }
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = path.extension().map(|e| e.to_string_lossy().into_owned());
    for n in 2.. {
        let name = match &ext {
            Some(ext) => format!("{stem} ({n}).{ext}"),
            None => format!("{stem} ({n})"),
        };
        let candidate = path.with_file_name(name);
        if !taken(&candidate) {
            return candidate;
        }
    }
    unreachable!("an unused file name always exists")
}

/// Name of the partial file of a download, stable across restarts so that it can be resumed.
/// Depends on the quality, because a partial file of another quality must not be continued.
pub fn part_file_name(server_id: &str, track_id: &str, quality: &str) -> String {
    let mut hasher = Sha256::new();
    for part in [server_id, track_id, quality] {
        hasher.update((part.len() as u64).to_le_bytes());
        hasher.update(part.as_bytes());
    }
    let digest = hasher.finalize();
    let mut name = String::with_capacity(37);
    for byte in digest.iter().take(16) {
        name.push_str(&format!("{byte:02x}"));
    }
    name.push_str(".part");
    name
}

/// Folder inside the downloads folder that holds partial files.
pub const PARTIAL_DIR: &str = ".partial";

/// `relative` as a string with `/` separators (what the database stores).
pub fn to_db_path(relative: &Path) -> String {
    relative
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// Resolves a database path against the downloads folder. Rejects absolute paths and `..` so a
/// damaged database can never point outside the folder.
pub fn from_db_path(base: &Path, stored: &str) -> Option<PathBuf> {
    let mut path = base.to_path_buf();
    for part in stored.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.contains(['\\', ':']) {
            return None;
        }
        path.push(part);
    }
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout() -> TrackLayout {
        TrackLayout {
            server_name: "Home".into(),
            album_artist: "Aurora Lane".into(),
            album: "Morning Static".into(),
            title: "Song 3".into(),
            disc_number: Some(1),
            track_number: Some(3),
            disc_total: Some(1),
        }
    }

    #[test]
    fn replaces_invalid_characters() {
        assert_eq!(sanitize_component("AC/DC: Live?"), "AC_DC_ Live_");
        assert_eq!(sanitize_component("a<b>c\"d|e*f\\g"), "a_b_c_d_e_f_g");
        assert_eq!(sanitize_component("tab\tand\nnewline"), "tab and newline");
    }

    #[test]
    fn strips_trailing_dots_and_spaces() {
        assert_eq!(sanitize_component("Mr. Brightside..."), "Mr. Brightside");
        assert_eq!(sanitize_component("  padded  "), "padded");
        assert_eq!(sanitize_component("..."), "_");
        assert_eq!(sanitize_component(""), "_");
        assert_eq!(sanitize_component(" . . "), "_");
    }

    #[test]
    fn avoids_reserved_device_names() {
        assert_eq!(sanitize_component("CON"), "_CON");
        assert_eq!(sanitize_component("nul"), "_nul");
        assert_eq!(sanitize_component("Com1.flac"), "_Com1.flac");
        assert_eq!(sanitize_component("LPT9"), "_LPT9");
        // Only the whole stem is reserved.
        assert_eq!(sanitize_component("Console"), "Console");
        assert_eq!(sanitize_component("CON TROL"), "CON TROL");
    }

    #[test]
    fn keeps_unicode_and_limits_length() {
        assert_eq!(
            sanitize_component("Björk – Vespertine"),
            "Björk – Vespertine"
        );
        assert_eq!(sanitize_component("日本語のタイトル"), "日本語のタイトル");
        let long = sanitize_component(&"ä".repeat(300));
        assert_eq!(long.chars().count(), MAX_COMPONENT);
        // Truncation must not leave a trailing dot or space behind.
        let tricky = sanitize_component(&format!("{} .{}", "x".repeat(98), "y".repeat(10)));
        assert!(!tricky.ends_with(['.', ' ']), "{tricky:?}");
    }

    #[test]
    fn strips_invisible_marks() {
        assert_eq!(sanitize_component("a\u{200B}b\u{202E}c"), "abc");
    }

    #[test]
    fn extension_is_clean() {
        assert_eq!(clean_extension(".FLAC"), "flac");
        assert_eq!(clean_extension("m4a/../../x"), "m4ax");
        assert_eq!(clean_extension(""), "bin");
        assert_eq!(clean_extension("🎵"), "bin");
    }

    #[test]
    fn builds_the_documented_layout() {
        let path = relative_track_path(&layout(), "flac", Path::new("C:/dl"));
        assert_eq!(
            to_db_path(&path),
            "Home/Aurora Lane/Morning Static/03 Song 3.flac"
        );
    }

    #[test]
    fn multi_disc_albums_get_a_disc_prefix() {
        let mut l = layout();
        l.disc_number = Some(2);
        assert_eq!(
            to_db_path(&relative_track_path(&l, "mp3", Path::new("/dl"))),
            "Home/Aurora Lane/Morning Static/2-03 Song 3.mp3"
        );
        // Disc 1 of a multi-disc album carries the prefix too, so the files sort correctly.
        l.disc_number = Some(1);
        l.disc_total = Some(2);
        assert!(
            to_db_path(&relative_track_path(&l, "mp3", Path::new("/dl")))
                .ends_with("/1-03 Song 3.mp3")
        );
    }

    #[test]
    fn fills_in_missing_metadata() {
        let l = TrackLayout {
            title: "Lonely".into(),
            ..Default::default()
        };
        assert_eq!(
            to_db_path(&relative_track_path(&l, "ogg", Path::new("/dl"))),
            "Server/Unknown Artist/Unknown Album/Lonely.ogg"
        );
    }

    #[test]
    fn long_paths_are_shortened_to_the_limit() {
        let l = TrackLayout {
            server_name: "S".repeat(60),
            album_artist: "A".repeat(150),
            album: "B".repeat(150),
            title: "T".repeat(150),
            disc_number: Some(1),
            track_number: Some(1),
            disc_total: None,
        };
        let base = Path::new("C:/Users/someone/AppData/Local/io.github.navify/downloads");
        let rel = relative_track_path(&l, "flac", base);
        let full = base.join(&rel);
        assert!(
            full.to_string_lossy().chars().count() <= MAX_PATH + 4,
            "{} chars: {full:?}",
            full.to_string_lossy().chars().count()
        );
        for component in rel.components() {
            let c = component.as_os_str().to_string_lossy();
            assert!(!c.ends_with(['.', ' ']), "{c:?}");
        }
        assert!(rel.to_string_lossy().ends_with(".flac"));
    }

    #[test]
    fn unique_path_appends_a_counter() {
        let taken = |p: &Path| {
            let n = p.file_name().unwrap().to_string_lossy().into_owned();
            n == "a.flac" || n == "a (2).flac"
        };
        assert_eq!(
            unique_path(Path::new("/x/b.flac"), taken),
            PathBuf::from("/x/b.flac")
        );
        assert_eq!(
            unique_path(Path::new("/x/a.flac"), taken),
            PathBuf::from("/x/a (3).flac")
        );
    }

    #[test]
    fn part_names_are_stable_and_distinct() {
        let a = part_file_name("s", "t", "original");
        assert_eq!(a, part_file_name("s", "t", "original"));
        assert_ne!(a, part_file_name("s", "t", "low"));
        assert_ne!(a, part_file_name("s", "t2", "original"));
        // ("ab","c") and ("a","bc") must not collide.
        assert_ne!(
            part_file_name("ab", "c", "q"),
            part_file_name("a", "bc", "q")
        );
        assert!(a.ends_with(".part") && a.len() == 37);
    }

    #[test]
    fn db_paths_cannot_escape_the_folder() {
        let base = Path::new("/dl");
        assert_eq!(
            from_db_path(base, "Home/Artist/Album/01 x.flac"),
            Some(PathBuf::from("/dl/Home/Artist/Album/01 x.flac"))
        );
        assert_eq!(from_db_path(base, "../etc/passwd"), None);
        assert_eq!(from_db_path(base, "a/../b"), None);
        assert_eq!(from_db_path(base, "/abs"), None);
        assert_eq!(from_db_path(base, "C:/Windows"), None);
        assert_eq!(from_db_path(base, "a\\b"), None);
    }
}
