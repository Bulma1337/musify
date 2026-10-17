//! Local SQLite database (`navify.db` in the app data folder): downloads and listening history.
//!
//! One connection behind a mutex is plenty for this workload. Never call [`Db::with`] on the main
//! thread: commands use [`run`], which moves the work to Tauri's blocking pool.

use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use tauri::Manager;

/// Schema migrations, applied in order; `PRAGMA user_version` stores how many ran.
///
/// Until the first public release a migration may still be edited in place (delete the dev
/// database afterwards). After that, only append new ones.
const MIGRATIONS: &[(&str, &str)] = &[
    ("downloads", include_str!("migrations/0001_downloads.sql")),
    ("history", include_str!("migrations/0002_history.sql")),
];

pub struct Db {
    conn: Mutex<Connection>,
}

/// Managed state: `State<'_, DbState>` in commands.
pub struct DbState(pub Arc<Db>);

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> rusqlite::Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> rusqlite::Result<Self> {
        conn.pragma_update(None, "foreign_keys", true)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        migrate(&mut conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Runs `f` with the connection. Blocks; keep it off the main thread.
    pub fn with<T>(
        &self,
        f: impl FnOnce(&mut Connection) -> rusqlite::Result<T>,
    ) -> Result<T, String> {
        // A panic while holding the lock leaves the connection itself intact, so recover it.
        let mut conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut conn).map_err(|e| e.to_string())
    }
}

fn migrate(conn: &mut Connection) -> rusqlite::Result<()> {
    let done: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    for (index, (name, sql)) in MIGRATIONS.iter().enumerate().skip(done.max(0) as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", index as i64 + 1)?;
        tx.commit()?;
        log::info!("database migration {} ({name}) applied", index + 1);
    }
    Ok(())
}

/// Runs a database job on the blocking pool (for async commands).
pub async fn run<T: Send + 'static>(
    db: &Arc<Db>,
    f: impl FnOnce(&mut Connection) -> rusqlite::Result<T> + Send + 'static,
) -> Result<T, String> {
    let db = Arc::clone(db);
    tauri::async_runtime::spawn_blocking(move || db.with(f))
        .await
        .map_err(|e| e.to_string())?
}

/// Opens `navify.db` in the app data folder. A database that can't be opened (corrupt, or from a
/// newer version) is moved aside so the app still starts; as a last resort it runs in memory.
pub fn open_app_db(app: &tauri::AppHandle) -> Arc<Db> {
    let dir = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(e) => {
            log::error!("no app data folder, using an in-memory database: {e}");
            return Arc::new(Db::open_in_memory().expect("in-memory database"));
        }
    };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log::error!("cannot create the app data folder: {e}");
    }
    let path = dir.join("navify.db");
    match Db::open(&path) {
        Ok(db) => return Arc::new(db),
        Err(e) => log::error!("cannot open the database, moving it aside: {e}"),
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = std::fs::rename(&path, dir.join(format!("navify.db.broken-{stamp}")));
    Db::open(&path).map(Arc::new).unwrap_or_else(|e| {
        log::error!("cannot create a new database, using memory: {e}");
        Arc::new(Db::open_in_memory().expect("in-memory database"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_apply_once() {
        let db = Db::open_in_memory().unwrap();
        let version: i64 = db
            .with(|c| c.query_row("PRAGMA user_version", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(version, MIGRATIONS.len() as i64);
        // Running again is a no-op.
        db.with(migrate).unwrap();
    }

    #[test]
    fn reopening_a_file_keeps_data() {
        let dir = std::env::current_dir()
            .unwrap()
            .join("target")
            .join("db-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("reopen.db");
        let _ = std::fs::remove_file(&path);
        {
            let db = Db::open(&path).unwrap();
            db.with(|c| {
                c.execute(
                    "INSERT INTO play_history (server_id, track_id, started_at, played_ms, duration_ms,
                       completed, skipped, title, artist, tz_offset_min)
                     VALUES ('s', 't', 1, 2, 3, 1, 0, 'Title', 'Artist', 60)",
                    [],
                )
            })
            .unwrap();
        }
        let db = Db::open(&path).unwrap();
        let count: i64 = db
            .with(|c| c.query_row("SELECT COUNT(*) FROM play_history", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(count, 1);
    }
}
