-- Local listening history: one row per playback of a track (statistics, Recap, automatic playlists).
-- Rows hold ids and a metadata snapshot only, never URLs or credentials.
CREATE TABLE play_history (
  id            INTEGER PRIMARY KEY,
  server_id     TEXT    NOT NULL,
  track_id      TEXT    NOT NULL,
  -- Unix time in ms (UTC) when playback started.
  started_at    INTEGER NOT NULL,
  -- Time actually heard: pauses excluded, seeks not counted as listening.
  played_ms     INTEGER NOT NULL,
  duration_ms   INTEGER NOT NULL,
  -- 1 = played to the end.
  completed     INTEGER NOT NULL,
  -- 1 = skipped before it counted as a play (not completed and not counted).
  skipped       INTEGER NOT NULL,
  -- 1 = counts as a play by the scrobble rule (half the track or 4 minutes, at least 30 s).
  counted       INTEGER NOT NULL DEFAULT 0,
  context_type  TEXT,
  context_id    TEXT,
  -- Metadata snapshot, so statistics work offline and after server changes.
  title         TEXT    NOT NULL,
  artist        TEXT    NOT NULL,
  artist_id     TEXT,
  album         TEXT,
  album_id      TEXT,
  genre         TEXT,
  cover         TEXT,
  -- Local UTC offset in minutes at play time, for time-of-day statistics.
  tz_offset_min INTEGER NOT NULL
);

CREATE INDEX play_history_time ON play_history (server_id, started_at);
CREATE INDEX play_history_track ON play_history (server_id, track_id);
