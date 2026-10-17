//! SQL for downloads, collections, covers and download settings. Plain functions on a connection,
//! so they can be tested with an in-memory database and run inside `db::run`.

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, Result, params};
use serde::{Deserialize, Serialize};

pub const STATE_QUEUED: &str = "queued";
pub const STATE_DOWNLOADING: &str = "downloading";
pub const STATE_DONE: &str = "done";
pub const STATE_FAILED: &str = "failed";

pub const SETTING_DIR: &str = "downloads_dir";

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Identifies a download: server id + track id.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct TrackKey {
    pub server_id: String,
    pub track_id: String,
}

impl TrackKey {
    pub fn new(server_id: impl Into<String>, track_id: impl Into<String>) -> Self {
        Self {
            server_id: server_id.into(),
            track_id: track_id.into(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackRow {
    pub server_id: String,
    pub track_id: String,
    pub state: String,
    /// Relative to the downloads folder; set once the file is complete.
    pub path: Option<String>,
    pub quality: String,
    pub container: Option<String>,
    pub size_bytes: i64,
    pub error: Option<String>,
    pub individual: bool,
    pub track_json: String,
    pub added_at: i64,
    pub completed_at: Option<i64>,
}

const TRACK_COLUMNS: &str = "server_id, track_id, state, path, quality, container, size_bytes, error, \
     individual, track_json, added_at, completed_at";

fn track_from_row(row: &rusqlite::Row<'_>) -> Result<TrackRow> {
    Ok(TrackRow {
        server_id: row.get(0)?,
        track_id: row.get(1)?,
        state: row.get(2)?,
        path: row.get(3)?,
        quality: row.get(4)?,
        container: row.get(5)?,
        size_bytes: row.get(6)?,
        error: row.get(7)?,
        individual: row.get::<_, i64>(8)? != 0,
        track_json: row.get(9)?,
        added_at: row.get(10)?,
        completed_at: row.get(11)?,
    })
}

pub fn get_track(conn: &Connection, key: &TrackKey) -> Result<Option<TrackRow>> {
    conn.query_row(
        &format!("SELECT {TRACK_COLUMNS} FROM downloads WHERE server_id = ?1 AND track_id = ?2"),
        params![key.server_id, key.track_id],
        track_from_row,
    )
    .optional()
}

pub fn list_tracks(conn: &Connection, server_id: &str) -> Result<Vec<TrackRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TRACK_COLUMNS} FROM downloads WHERE server_id = ?1 ORDER BY added_at, track_id"
    ))?;
    stmt.query_map(params![server_id], track_from_row)?
        .collect()
}

pub fn all_tracks(conn: &Connection) -> Result<Vec<TrackRow>> {
    let mut stmt = conn.prepare(&format!("SELECT {TRACK_COLUMNS} FROM downloads"))?;
    stmt.query_map([], track_from_row)?.collect()
}

/// Rows left `downloading` by a crash or quit go back to the queue; the frontend resumes them.
pub fn reset_interrupted(conn: &Connection) -> Result<usize> {
    conn.execute(
        "UPDATE downloads SET state = 'queued' WHERE state = 'downloading'",
        [],
    )
}

pub struct QueuedTrack<'a> {
    pub key: &'a TrackKey,
    pub quality: &'a str,
    pub container: Option<&'a str>,
    pub track_json: &'a str,
    pub individual: bool,
}

/// Inserts a track as queued, or re-queues a failed/interrupted one. `individual` only ever goes
/// from 0 to 1 here.
pub fn upsert_queued(conn: &Connection, t: &QueuedTrack<'_>) -> Result<()> {
    conn.execute(
        "INSERT INTO downloads (server_id, track_id, state, quality, container, individual, track_json, added_at)
         VALUES (?1, ?2, 'queued', ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (server_id, track_id) DO UPDATE SET
           state = 'queued', error = NULL, quality = excluded.quality,
           container = excluded.container, track_json = excluded.track_json,
           individual = MAX(individual, excluded.individual)",
        params![
            t.key.server_id,
            t.key.track_id,
            t.quality,
            t.container,
            t.individual,
            t.track_json,
            now_ms()
        ],
    )?;
    Ok(())
}

pub fn set_individual(conn: &Connection, key: &TrackKey, individual: bool) -> Result<()> {
    conn.execute(
        "UPDATE downloads SET individual = ?3 WHERE server_id = ?1 AND track_id = ?2",
        params![key.server_id, key.track_id, individual],
    )?;
    Ok(())
}

pub fn set_state(
    conn: &Connection,
    key: &TrackKey,
    state: &str,
    error: Option<&str>,
) -> Result<()> {
    conn.execute(
        "UPDATE downloads SET state = ?3, error = ?4 WHERE server_id = ?1 AND track_id = ?2",
        params![key.server_id, key.track_id, state, error],
    )?;
    Ok(())
}

pub fn mark_done(
    conn: &Connection,
    key: &TrackKey,
    path: &str,
    size_bytes: u64,
    container: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE downloads SET state = 'done', path = ?3, size_bytes = ?4, container = ?5,
           error = NULL, completed_at = ?6
         WHERE server_id = ?1 AND track_id = ?2",
        params![
            key.server_id,
            key.track_id,
            path,
            size_bytes as i64,
            container,
            now_ms()
        ],
    )?;
    Ok(())
}

pub fn delete_track(conn: &Connection, key: &TrackKey) -> Result<()> {
    conn.execute(
        "DELETE FROM downloads WHERE server_id = ?1 AND track_id = ?2",
        params![key.server_id, key.track_id],
    )?;
    Ok(())
}

/// Total size of completed downloads.
pub fn downloaded_bytes(conn: &Connection) -> Result<u64> {
    let bytes: i64 = conn.query_row(
        "SELECT COALESCE(SUM(size_bytes), 0) FROM downloads WHERE state = 'done'",
        [],
        |r| r.get(0),
    )?;
    Ok(bytes.max(0) as u64)
}

pub fn count_done(conn: &Connection) -> Result<u64> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM downloads WHERE state = 'done'",
        [],
        |r| r.get(0),
    )?;
    Ok(n.max(0) as u64)
}

// --- Collections ---------------------------------------------------------------------------------

/// An album, playlist or the favorites, registered for download.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionInput {
    pub server_id: String,
    pub kind: String,
    pub item_id: String,
    pub name: String,
    /// Snapshot for offline browsing (opaque to the backend).
    pub json: String,
    /// Track ids in display order.
    pub track_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionRow {
    pub server_id: String,
    pub kind: String,
    pub item_id: String,
    pub name: String,
    pub json: String,
    pub added_at: i64,
    pub synced_at: Option<i64>,
    pub track_ids: Vec<String>,
}

/// Registers or updates a collection and replaces its track list. Keeps `added_at`.
pub fn upsert_collection(conn: &mut Connection, c: &CollectionInput) -> Result<()> {
    let tx = conn.transaction()?;
    let now = now_ms();
    tx.execute(
        "INSERT INTO download_collections (server_id, kind, item_id, name, json, added_at, synced_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT (server_id, kind, item_id) DO UPDATE SET
           name = excluded.name, json = excluded.json, synced_at = excluded.synced_at",
        params![c.server_id, c.kind, c.item_id, c.name, c.json, now],
    )?;
    tx.execute(
        "DELETE FROM download_collection_tracks WHERE server_id = ?1 AND kind = ?2 AND item_id = ?3",
        params![c.server_id, c.kind, c.item_id],
    )?;
    {
        let mut insert = tx.prepare(
            "INSERT OR IGNORE INTO download_collection_tracks (server_id, kind, item_id, track_id, position)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        for (position, track_id) in c.track_ids.iter().enumerate() {
            insert.execute(params![
                c.server_id,
                c.kind,
                c.item_id,
                track_id,
                position as i64
            ])?;
        }
    }
    tx.commit()
}

pub fn delete_collection(
    conn: &Connection,
    server_id: &str,
    kind: &str,
    item_id: &str,
) -> Result<()> {
    // Track rows go with it through the foreign key.
    conn.execute(
        "DELETE FROM download_collections WHERE server_id = ?1 AND kind = ?2 AND item_id = ?3",
        params![server_id, kind, item_id],
    )?;
    Ok(())
}

pub fn list_collections(conn: &Connection, server_id: &str) -> Result<Vec<CollectionRow>> {
    let mut stmt = conn.prepare(
        "SELECT server_id, kind, item_id, name, json, added_at, synced_at
         FROM download_collections WHERE server_id = ?1 ORDER BY added_at, item_id",
    )?;
    let mut rows: Vec<CollectionRow> = stmt
        .query_map(params![server_id], |r| {
            Ok(CollectionRow {
                server_id: r.get(0)?,
                kind: r.get(1)?,
                item_id: r.get(2)?,
                name: r.get(3)?,
                json: r.get(4)?,
                added_at: r.get(5)?,
                synced_at: r.get(6)?,
                track_ids: Vec::new(),
            })
        })?
        .collect::<Result<_>>()?;
    let mut tracks = conn.prepare(
        "SELECT track_id FROM download_collection_tracks
         WHERE server_id = ?1 AND kind = ?2 AND item_id = ?3 ORDER BY position",
    )?;
    for row in &mut rows {
        row.track_ids = tracks
            .query_map(params![row.server_id, row.kind, row.item_id], |r| r.get(0))?
            .collect::<Result<_>>()?;
    }
    Ok(rows)
}

/// True when a collection still lists the track.
pub fn in_any_collection(conn: &Connection, key: &TrackKey) -> Result<bool> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM download_collection_tracks WHERE server_id = ?1 AND track_id = ?2)",
        params![key.server_id, key.track_id],
        |r| r.get(0),
    )
}

/// Tracks of a server that no collection lists and that were not downloaded individually.
pub fn orphaned_tracks(conn: &Connection, server_id: &str) -> Result<Vec<TrackRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TRACK_COLUMNS} FROM downloads d
         WHERE d.server_id = ?1 AND d.individual = 0
           AND NOT EXISTS (SELECT 1 FROM download_collection_tracks m
                           WHERE m.server_id = d.server_id AND m.track_id = d.track_id)"
    ))?;
    stmt.query_map(params![server_id], track_from_row)?
        .collect()
}

// --- Covers and settings ---------------------------------------------------------------------------

pub fn get_cover_path(
    conn: &Connection,
    server_id: &str,
    cover_ref: &str,
) -> Result<Option<String>> {
    conn.query_row(
        "SELECT path FROM download_covers WHERE server_id = ?1 AND cover_ref = ?2",
        params![server_id, cover_ref],
        |r| r.get(0),
    )
    .optional()
}

pub fn set_cover_path(
    conn: &Connection,
    server_id: &str,
    cover_ref: &str,
    path: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO download_covers (server_id, cover_ref, path) VALUES (?1, ?2, ?3)
         ON CONFLICT (server_id, cover_ref) DO UPDATE SET path = excluded.path",
        params![server_id, cover_ref, path],
    )?;
    Ok(())
}

pub fn delete_covers_at(conn: &Connection, path: &str) -> Result<()> {
    conn.execute("DELETE FROM download_covers WHERE path = ?1", params![path])?;
    Ok(())
}

pub fn all_cover_paths(conn: &Connection) -> Result<HashSet<String>> {
    let mut stmt = conn.prepare("SELECT path FROM download_covers")?;
    stmt.query_map([], |r| r.get(0))?.collect()
}

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    conn.query_row(
        "SELECT value FROM download_settings WHERE key = ?1",
        params![key],
        |r| r.get(0),
    )
    .optional()
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO download_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn db() -> Db {
        Db::open_in_memory().unwrap()
    }

    fn queue(conn: &Connection, key: &TrackKey, individual: bool) {
        upsert_queued(
            conn,
            &QueuedTrack {
                key,
                quality: "original",
                container: Some("flac"),
                track_json: "{}",
                individual,
            },
        )
        .unwrap();
    }

    fn collection(kind: &str, id: &str, tracks: &[&str]) -> CollectionInput {
        CollectionInput {
            server_id: "s".into(),
            kind: kind.into(),
            item_id: id.into(),
            name: id.into(),
            json: "{}".into(),
            track_ids: tracks.iter().map(|t| t.to_string()).collect(),
        }
    }

    #[test]
    fn track_state_transitions() {
        let db = db();
        let key = TrackKey::new("s", "t1");
        db.with(|c| {
            queue(c, &key, false);
            assert_eq!(get_track(c, &key)?.unwrap().state, STATE_QUEUED);
            set_state(c, &key, STATE_DOWNLOADING, None)?;
            assert_eq!(get_track(c, &key)?.unwrap().state, STATE_DOWNLOADING);
            // A crash leaves "downloading"; the next start queues it again.
            assert_eq!(reset_interrupted(c)?, 1);
            assert_eq!(get_track(c, &key)?.unwrap().state, STATE_QUEUED);
            set_state(c, &key, STATE_FAILED, Some("HTTP status 500"))?;
            let row = get_track(c, &key)?.unwrap();
            assert_eq!(
                (row.state.as_str(), row.error.as_deref()),
                (STATE_FAILED, Some("HTTP status 500"))
            );
            // Retrying clears the error.
            queue(c, &key, false);
            assert_eq!(get_track(c, &key)?.unwrap().error, None);
            mark_done(c, &key, "a/b/c.flac", 1234, "flac")?;
            let row = get_track(c, &key)?.unwrap();
            assert_eq!(row.state, STATE_DONE);
            assert_eq!(row.path.as_deref(), Some("a/b/c.flac"));
            assert_eq!(downloaded_bytes(c)?, 1234);
            assert_eq!(count_done(c)?, 1);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn individual_flag_only_grows() {
        let db = db();
        let key = TrackKey::new("s", "t1");
        db.with(|c| {
            queue(c, &key, false);
            assert!(!get_track(c, &key)?.unwrap().individual);
            queue(c, &key, true);
            assert!(get_track(c, &key)?.unwrap().individual);
            // Re-queueing as part of a collection does not take the flag away.
            queue(c, &key, false);
            assert!(get_track(c, &key)?.unwrap().individual);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn orphans_are_tracks_in_no_collection_and_not_individual() {
        let db = db();
        db.with(|c| {
            for (id, individual) in [("a", false), ("b", false), ("c", true), ("d", false)] {
                queue(c, &TrackKey::new("s", id), individual);
            }
            // The same album and playlist both list "a"; "b" is only in the album; "c" is individual.
            upsert_collection(c, &collection("album", "al1", &["a", "b"]))?;
            upsert_collection(c, &collection("playlist", "pl1", &["a"]))?;
            let orphans = |c: &Connection| -> Result<Vec<String>> {
                let mut ids: Vec<String> = orphaned_tracks(c, "s")?
                    .into_iter()
                    .map(|r| r.track_id)
                    .collect();
                ids.sort();
                Ok(ids)
            };
            assert_eq!(orphans(c)?, vec!["d"]);
            // Removing the album keeps "a" (still in the playlist) but frees "b".
            delete_collection(c, "s", "album", "al1")?;
            assert_eq!(orphans(c)?, vec!["b", "d"]);
            delete_collection(c, "s", "playlist", "pl1")?;
            assert_eq!(orphans(c)?, vec!["a", "b", "d"]);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn collections_replace_their_tracks_and_keep_order() {
        let db = db();
        db.with(|c| {
            upsert_collection(c, &collection("playlist", "pl", &["x", "y", "z"]))?;
            let first = list_collections(c, "s")?;
            assert_eq!(first[0].track_ids, vec!["x", "y", "z"]);
            let added_at = first[0].added_at;
            upsert_collection(c, &collection("playlist", "pl", &["z", "w"]))?;
            let second = list_collections(c, "s")?;
            assert_eq!(second.len(), 1);
            assert_eq!(second[0].track_ids, vec!["z", "w"]);
            assert_eq!(second[0].added_at, added_at);
            assert!(in_any_collection(c, &TrackKey::new("s", "w"))?);
            assert!(!in_any_collection(c, &TrackKey::new("s", "x"))?);
            // Other servers are separate.
            assert!(list_collections(c, "other")?.is_empty());
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn covers_and_settings_round_trip() {
        let db = db();
        db.with(|c| {
            assert_eq!(get_cover_path(c, "s", "al1")?, None);
            set_cover_path(c, "s", "al1", "Home/A/B/cover.jpg")?;
            set_cover_path(c, "s", "al2", "Home/A/B/cover.jpg")?;
            assert_eq!(
                get_cover_path(c, "s", "al1")?.as_deref(),
                Some("Home/A/B/cover.jpg")
            );
            delete_covers_at(c, "Home/A/B/cover.jpg")?;
            assert_eq!(get_cover_path(c, "s", "al2")?, None);
            assert_eq!(get_setting(c, SETTING_DIR)?, None);
            set_setting(c, SETTING_DIR, "D:/music")?;
            set_setting(c, SETTING_DIR, "E:/music")?;
            assert_eq!(get_setting(c, SETTING_DIR)?.as_deref(), Some("E:/music"));
            Ok(())
        })
        .unwrap();
    }
}
