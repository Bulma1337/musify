-- Offline copies of tracks. One row per server and track; files live in the downloads folder.
CREATE TABLE downloads (
  server_id    TEXT    NOT NULL,
  track_id     TEXT    NOT NULL,
  -- queued | downloading | done | failed
  state        TEXT    NOT NULL,
  -- Path relative to the downloads folder, set once the file is complete.
  path         TEXT,
  -- Requested quality preset: original | high | normal | low.
  quality      TEXT    NOT NULL,
  container    TEXT,
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  -- 1 when the user downloaded the track itself (not only as part of an album, playlist or favorites).
  individual   INTEGER NOT NULL DEFAULT 0,
  -- Track snapshot (JSON) so downloaded music can be browsed and played offline.
  track_json   TEXT    NOT NULL,
  added_at     INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (server_id, track_id)
) WITHOUT ROWID;

CREATE INDEX downloads_state ON downloads (state);

-- Albums, playlists and favorites downloaded as a whole; kept in sync with the server.
CREATE TABLE download_collections (
  server_id TEXT    NOT NULL,
  -- album | playlist | favorites
  kind      TEXT    NOT NULL,
  item_id   TEXT    NOT NULL,
  name      TEXT    NOT NULL,
  -- Collection snapshot (JSON): cover, owner, track ids in order.
  json      TEXT    NOT NULL,
  added_at  INTEGER NOT NULL,
  synced_at INTEGER,
  PRIMARY KEY (server_id, kind, item_id)
) WITHOUT ROWID;

-- Which tracks belong to which collection. A downloaded file is kept as long as the track was downloaded
-- individually or at least one collection still lists it.
CREATE TABLE download_collection_tracks (
  server_id TEXT    NOT NULL,
  kind      TEXT    NOT NULL,
  item_id   TEXT    NOT NULL,
  track_id  TEXT    NOT NULL,
  position  INTEGER NOT NULL,
  PRIMARY KEY (server_id, kind, item_id, track_id),
  FOREIGN KEY (server_id, kind, item_id) REFERENCES download_collections (server_id, kind, item_id)
    ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX download_collection_tracks_track ON download_collection_tracks (server_id, track_id);

-- Cover image saved next to the downloaded tracks of an album, by the server's cover reference.
CREATE TABLE download_covers (
  server_id TEXT NOT NULL,
  cover_ref TEXT NOT NULL,
  -- Path relative to the downloads folder.
  path      TEXT NOT NULL,
  PRIMARY KEY (server_id, cover_ref)
) WITHOUT ROWID;

-- Small key/value store for download settings (e.g. the downloads folder).
CREATE TABLE download_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
