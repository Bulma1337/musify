-- Offline copies of tracks. One row per server and track; files live in the downloads folder.
CREATE TABLE downloads (
  server_id    TEXT    NOT NULL,
  track_id     TEXT    NOT NULL,
  -- queued | downloading | done | failed
  state        TEXT    NOT NULL,
  -- Path relative to the downloads folder, set once the file is complete.
  path         TEXT,
  -- Requested quality, e.g. "original" or "opus-160".
  quality      TEXT    NOT NULL,
  container    TEXT,
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
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
