//! Discord Rich Presence: "Listening to Musify" with title, artists, cover and a progress bar.
//!
//! Talks to the local Discord client over its IPC pipe (`\\.\pipe\discord-ipc-N` on Windows, a Unix
//! socket elsewhere). A worker thread owns the connection, reconnects when Discord starts later and
//! sends at most one update per second (Discord allows five per 20 s), always the newest one.

use std::io::{Read, Write};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crossbeam_channel::{Receiver, RecvTimeoutError, Sender};
use serde::Deserialize;
use serde_json::{Value, json};

/// The "Musify" application in the Discord developer portal. Its name is what Discord shows
/// ("Listening to Musify"); the `musify` image asset is the small logo.
pub const CLIENT_ID: &str = "";

const OP_HANDSHAKE: u32 = 0;
const OP_FRAME: u32 = 1;
const OP_CLOSE: u32 = 2;
/// Activity type "Listening" (shows a progress bar with start/end timestamps).
const LISTENING: u8 = 2;
const MIN_INTERVAL: Duration = Duration::from_secs(1);
const RETRY: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Presence {
    title: String,
    artists: String,
    album: Option<String>,
    /// A public image URL (never the music server's URL: it would expose credentials).
    cover_url: Option<String>,
    duration_ms: Option<u64>,
    position_ms: u64,
    playing: bool,
    /// Shown instead of the artists while paused ("Paused").
    paused_label: String,
}

trait Pipe: Read + Write + Send {}
impl<T: Read + Write + Send> Pipe for T {}

#[cfg(windows)]
fn open_pipe(index: u8) -> std::io::Result<Box<dyn Pipe>> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(format!(r"\\.\pipe\discord-ipc-{index}"))?;
    Ok(Box::new(file))
}

#[cfg(unix)]
fn open_pipe(index: u8) -> std::io::Result<Box<dyn Pipe>> {
    let dir = ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"]
        .iter()
        .find_map(|v| std::env::var(v).ok())
        .unwrap_or_else(|| "/tmp".into());
    let stream = std::os::unix::net::UnixStream::connect(format!("{dir}/discord-ipc-{index}"))?;
    Ok(Box::new(stream))
}

struct Connection {
    pipe: Box<dyn Pipe>,
    nonce: u64,
}

fn write_frame(pipe: &mut dyn Pipe, op: u32, body: &Value) -> std::io::Result<()> {
    let data = serde_json::to_vec(body)?;
    let mut frame = Vec::with_capacity(8 + data.len());
    frame.extend_from_slice(&op.to_le_bytes());
    frame.extend_from_slice(&(data.len() as u32).to_le_bytes());
    frame.extend_from_slice(&data);
    pipe.write_all(&frame)?;
    pipe.flush()
}

fn read_frame(pipe: &mut dyn Pipe) -> std::io::Result<(u32, Value)> {
    let mut header = [0u8; 8];
    pipe.read_exact(&mut header)?;
    let op = u32::from_le_bytes([header[0], header[1], header[2], header[3]]);
    let len = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
    if len > 1 << 20 {
        return Err(std::io::Error::other("frame too large"));
    }
    let mut body = vec![0u8; len];
    pipe.read_exact(&mut body)?;
    let value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    Ok((op, value))
}

impl Connection {
    fn open(client_id: &str) -> std::io::Result<Self> {
        let mut last = std::io::Error::other("Discord is not running");
        for index in 0..10 {
            match open_pipe(index) {
                Ok(mut pipe) => {
                    write_frame(
                        pipe.as_mut(),
                        OP_HANDSHAKE,
                        &json!({ "v": 1, "client_id": client_id }),
                    )?;
                    let (op, _ready) = read_frame(pipe.as_mut())?;
                    if op == OP_CLOSE {
                        return Err(std::io::Error::other("Discord refused the connection"));
                    }
                    return Ok(Self { pipe, nonce: 0 });
                }
                Err(e) => last = e,
            }
        }
        Err(last)
    }

    fn set_activity(&mut self, activity: Option<Value>) -> std::io::Result<()> {
        self.nonce += 1;
        let body = json!({
            "cmd": "SET_ACTIVITY",
            "args": { "pid": std::process::id(), "activity": activity },
            "nonce": self.nonce.to_string(),
        });
        write_frame(self.pipe.as_mut(), OP_FRAME, &body)?;
        let (op, reply) = read_frame(self.pipe.as_mut())?;
        if op == OP_CLOSE || reply.get("evt").and_then(Value::as_str) == Some("ERROR") {
            return Err(std::io::Error::other("Discord rejected the activity"));
        }
        Ok(())
    }
}

/// Discord limits texts to 128 characters (and wants at least two).
fn text(value: &str) -> String {
    let mut t: String = value.chars().take(128).collect();
    while t.chars().count() < 2 {
        t.push(' ');
    }
    t
}

fn activity(p: &Presence, now_ms: u64) -> Value {
    let mut assets = serde_json::Map::new();
    assets.insert(
        "large_image".into(),
        json!(p.cover_url.as_deref().unwrap_or("musify")),
    );
    assets.insert(
        "large_text".into(),
        json!(text(p.album.as_deref().unwrap_or(&p.title))),
    );
    assets.insert("small_image".into(), json!("musify"));
    assets.insert("small_text".into(), json!("Musify"));
    let mut activity = json!({
        "type": LISTENING,
        "details": text(&p.title),
        "state": text(if p.playing { &p.artists } else { &p.paused_label }),
        "assets": assets,
    });
    if p.playing
        && let Some(duration) = p.duration_ms.filter(|d| *d > 0)
    {
        let start = now_ms.saturating_sub(p.position_ms.min(duration));
        activity["timestamps"] = json!({ "start": start, "end": start + duration });
    }
    activity
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub struct DiscordState {
    tx: Sender<Option<Presence>>,
}

impl DiscordState {
    pub fn start() -> Self {
        let (tx, rx) = crossbeam_channel::unbounded();
        if !CLIENT_ID.is_empty() {
            let _ = std::thread::Builder::new()
                .name("musify-discord".into())
                .spawn(move || run(&rx));
        }
        Self { tx }
    }
}

fn run(rx: &Receiver<Option<Presence>>) {
    let mut connection: Option<Connection> = None;
    // `Some(x)`: an update to send (`x` = None clears the activity).
    let mut pending: Option<Option<Presence>> = None;
    let mut last_sent = Instant::now() - MIN_INTERVAL;
    let mut retry_at = Instant::now();
    loop {
        let wait = if pending.is_some() {
            MIN_INTERVAL
                .saturating_sub(last_sent.elapsed())
                .max(Duration::from_millis(50))
        } else {
            Duration::from_secs(60)
        };
        match rx.recv_timeout(wait) {
            Ok(update) => {
                pending = Some(update);
                // Take everything queued: only the newest state matters.
                while let Ok(newer) = rx.try_recv() {
                    pending = Some(newer);
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        let Some(update) = pending.clone() else {
            continue;
        };
        if last_sent.elapsed() < MIN_INTERVAL {
            continue;
        }
        if connection.is_none() {
            if Instant::now() < retry_at {
                continue;
            }
            match Connection::open(CLIENT_ID) {
                Ok(c) => connection = Some(c),
                Err(_) => {
                    retry_at = Instant::now() + RETRY;
                    // Nothing to clear while Discord is closed.
                    if update.is_none() {
                        pending = None;
                    }
                    continue;
                }
            }
        }
        let Some(conn) = connection.as_mut() else {
            continue;
        };
        let payload = update.as_ref().map(|p| activity(p, now_ms()));
        last_sent = Instant::now();
        match conn.set_activity(payload) {
            Ok(()) => pending = None,
            Err(_) => {
                // Discord was closed or restarted: reconnect for the next attempt.
                connection = None;
                retry_at = Instant::now() + RETRY;
            }
        }
    }
}

/// Shows the presence, or clears it with `None`.
#[tauri::command]
pub fn discord_presence(state: tauri::State<'_, DiscordState>, presence: Option<Presence>) {
    let _ = state.tx.send(presence);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn presence(playing: bool) -> Presence {
        Presence {
            title: "Song".into(),
            artists: "A, B".into(),
            album: Some("Album".into()),
            cover_url: None,
            duration_ms: Some(180_000),
            position_ms: 30_000,
            playing,
            paused_label: "Paused".into(),
        }
    }

    #[test]
    fn listening_activity_with_progress_bar() {
        let a = activity(&presence(true), 1_000_000);
        assert_eq!(a["type"], 2);
        assert_eq!(a["details"], "Song");
        assert_eq!(a["state"], "A, B");
        assert_eq!(a["timestamps"]["start"], 970_000);
        assert_eq!(a["timestamps"]["end"], 1_150_000);
        assert_eq!(a["assets"]["large_image"], "musify");
        assert_eq!(a["assets"]["small_text"], "Musify");
    }

    #[test]
    fn paused_has_no_progress_bar() {
        let a = activity(&presence(false), 1_000_000);
        assert!(a.get("timestamps").is_none());
        assert_eq!(a["state"], "Paused");
    }

    #[test]
    fn texts_fit_discord_limits() {
        assert_eq!(text("x").chars().count(), 2);
        assert_eq!(text(&"y".repeat(300)).chars().count(), 128);
    }

    #[test]
    fn frames_round_trip() {
        let mut buffer = std::io::Cursor::new(Vec::new());
        write_frame(&mut buffer, OP_FRAME, &json!({ "a": 1 })).unwrap();
        buffer.set_position(0);
        let (op, value) = read_frame(&mut buffer).unwrap();
        assert_eq!(op, OP_FRAME);
        assert_eq!(value["a"], 1);
    }
}
