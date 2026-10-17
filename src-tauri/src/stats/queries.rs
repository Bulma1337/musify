//! Listening statistics over the `play_history` table.
//!
//! Terms used throughout:
//! - *play*: a row with `counted = 1` (same rule as scrobbling, decided by the frontend).
//! - *minutes*: the sum of `played_ms` over all rows, plays and skips alike, because skipped
//!   music was still heard.
//! - *local time*: `started_at + tz_offset_min`, using the offset recorded with each row, so a
//!   late-night session stays a late-night session after travelling or a DST change.
//!
//! All ranges are half-open `[from, to)` in Unix milliseconds (UTC); the caller turns "this
//! year" or "last 4 weeks" into bounds in the user's local calendar.

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

pub const DAY_MS: i64 = 86_400_000;
/// "Deine Dauerbrenner": the last 30 days.
const HEAVY_ROTATION_DAYS: i64 = 30;
/// "Wiederentdeckt": plays older than ~6 months ...
const REDISCOVER_OLDER_THAN_DAYS: i64 = 182;
/// ... and nothing in the last ~2 months ...
const REDISCOVER_QUIET_DAYS: i64 = 61;
/// ... with at least this many plays back then.
const REDISCOVER_MIN_PLAYS: i64 = 3;
/// A track needs at least two plays in 30 days to count as heavy rotation.
const HEAVY_ROTATION_MIN_PLAYS: i64 = 2;

/// One finished playback, as reported by the frontend.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPlay {
    pub server_id: String,
    pub track_id: String,
    pub started_at: i64,
    pub played_ms: i64,
    pub duration_ms: i64,
    pub completed: bool,
    pub skipped: bool,
    pub counted: bool,
    pub context_type: Option<String>,
    pub context_id: Option<String>,
    pub title: String,
    pub artist: String,
    pub artist_id: Option<String>,
    pub album: Option<String>,
    pub album_id: Option<String>,
    pub genre: Option<String>,
    pub cover: Option<String>,
    pub tz_offset_min: i32,
}

pub fn insert_play(conn: &Connection, play: &NewPlay) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO play_history (server_id, track_id, started_at, played_ms, duration_ms, completed,
           skipped, counted, context_type, context_id, title, artist, artist_id, album, album_id,
           genre, cover, tz_offset_min)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
        params![
            play.server_id,
            play.track_id,
            play.started_at,
            play.played_ms.max(0),
            play.duration_ms.max(0),
            play.completed,
            play.skipped,
            play.counted,
            play.context_type,
            play.context_id,
            play.title,
            play.artist,
            play.artist_id,
            play.album,
            play.album_id,
            play.genre,
            play.cover,
            play.tz_offset_min,
        ],
    )?;
    Ok(())
}

/// One entry of a top list. The meaning of `id`/`title` depends on the list:
/// track (track id, title), artist (artist id, name), album (album id, name), genre (-, name).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatRow {
    pub id: Option<String>,
    pub title: String,
    pub artist: Option<String>,
    pub artist_id: Option<String>,
    pub album: Option<String>,
    pub album_id: Option<String>,
    pub genre: Option<String>,
    pub cover: Option<String>,
    pub plays: i64,
    pub played_ms: i64,
    pub last_played_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Group {
    Track,
    Artist,
    Album,
    Genre,
}

impl Group {
    /// The grouping key and a filter that drops rows without that dimension.
    fn key(self) -> (&'static str, &'static str) {
        match self {
            Group::Track => ("track_id", "1"),
            Group::Artist => ("COALESCE(artist_id, artist)", "artist <> ''"),
            Group::Album => ("album_id", "album_id IS NOT NULL"),
            Group::Genre => ("genre", "genre IS NOT NULL AND genre <> ''"),
        }
    }

    /// Columns shown for the group; the single `MAX(started_at)` in the query makes SQLite
    /// take them from the most recent row, so renamed tracks show their latest metadata.
    fn id_title(self) -> (&'static str, &'static str) {
        match self {
            Group::Track => ("track_id", "title"),
            Group::Artist => ("artist_id", "artist"),
            Group::Album => ("album_id", "album"),
            Group::Genre => ("NULL", "genre"),
        }
    }
}

/// A SQL fragment appended to the WHERE clause of [`top_groups`] (it can use ?1 server, ?2 from,
/// ?3 to) and one appended after GROUP BY (HAVING).
#[derive(Default)]
struct Extra {
    filter: String,
    having: String,
    /// Extra parameter bound as ?5.
    param: Option<i64>,
}

fn row_to_stat(row: &rusqlite::Row<'_>) -> rusqlite::Result<StatRow> {
    Ok(StatRow {
        id: row.get(0)?,
        title: row.get(1)?,
        artist: row.get(2)?,
        artist_id: row.get(3)?,
        album: row.get(4)?,
        album_id: row.get(5)?,
        genre: row.get(6)?,
        cover: row.get(7)?,
        plays: row.get(8)?,
        played_ms: row.get(9)?,
        last_played_at: row.get(10)?,
    })
}

fn top_groups(
    conn: &Connection,
    group: Group,
    server_id: &str,
    from: i64,
    to: i64,
    limit: i64,
    extra: &Extra,
) -> rusqlite::Result<Vec<StatRow>> {
    let (key, key_filter) = group.key();
    let (id, title) = group.id_title();
    // Plays of a group: counted rows only; groups with only skips are not "top" anything.
    let sql = format!(
        "SELECT {id}, {title}, artist, artist_id, album, album_id, genre, cover,
                SUM(counted) AS plays, SUM(played_ms) AS ms, MAX(started_at) AS last
         FROM play_history
         WHERE server_id = ?1 AND started_at >= ?2 AND started_at < ?3 AND {key_filter} {filter}
         GROUP BY {key}
         HAVING SUM(counted) >= 1 {having}
         ORDER BY plays DESC, ms DESC, {key}
         LIMIT ?4",
        filter = extra.filter,
        having = extra.having,
    );
    let mut stmt = conn.prepare(&sql)?;
    let mapped = match extra.param {
        Some(p) => stmt.query_map(params![server_id, from, to, limit, p], row_to_stat)?,
        None => stmt.query_map(params![server_id, from, to, limit], row_to_stat)?,
    };
    mapped.collect()
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Streak {
    pub days: i64,
    /// Local day numbers (days since 1970-01-01); 0/0 when there is no listening.
    pub start_day: i64,
    pub end_day: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MonthStat {
    /// "2026-03" in local time.
    pub month: String,
    pub played_ms: i64,
    pub plays: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Discoveries {
    /// Tracks whose first play ever falls into the range.
    pub tracks: i64,
    /// Artists whose first play ever falls into the range.
    pub artists: i64,
    /// The most played of the newly discovered tracks.
    pub top: Vec<StatRow>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub played_ms: i64,
    pub plays: i64,
    pub skips: i64,
    pub distinct_tracks: i64,
    pub active_days: i64,
    pub top_tracks: Vec<StatRow>,
    pub top_artists: Vec<StatRow>,
    pub top_albums: Vec<StatRow>,
    pub top_genres: Vec<StatRow>,
    /// Listening time in ms by weekday (Monday = 0) and local hour.
    pub heatmap: [[i64; 24]; 7],
    pub longest_streak: Streak,
    pub discoveries: Discoveries,
    pub months: Vec<MonthStat>,
}

/// SQL expression: the row's start time in local seconds (as if local time were UTC).
const LOCAL_SECS: &str = "(started_at / 1000 + tz_offset_min * 60)";

pub fn summary(
    conn: &Connection,
    server_id: &str,
    from: i64,
    to: i64,
    top_limit: i64,
) -> rusqlite::Result<Summary> {
    let (played_ms, plays, skips, distinct_tracks) = conn.query_row(
        "SELECT COALESCE(SUM(played_ms), 0), COALESCE(SUM(counted), 0), COALESCE(SUM(skipped), 0),
                COUNT(DISTINCT CASE WHEN counted = 1 THEN track_id END)
         FROM play_history WHERE server_id = ?1 AND started_at >= ?2 AND started_at < ?3",
        params![server_id, from, to],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;

    let none = Extra::default();
    let top_tracks = top_groups(conn, Group::Track, server_id, from, to, top_limit, &none)?;
    let top_artists = top_groups(conn, Group::Artist, server_id, from, to, top_limit, &none)?;
    let top_albums = top_groups(conn, Group::Album, server_id, from, to, top_limit, &none)?;
    let top_genres = top_groups(conn, Group::Genre, server_id, from, to, top_limit, &none)?;

    let mut heatmap = [[0i64; 24]; 7];
    {
        let sql = format!(
            "SELECT CAST(strftime('%w', {LOCAL_SECS}, 'unixepoch') AS INTEGER),
                    CAST(strftime('%H', {LOCAL_SECS}, 'unixepoch') AS INTEGER),
                    SUM(played_ms)
             FROM play_history WHERE server_id = ?1 AND started_at >= ?2 AND started_at < ?3
             GROUP BY 1, 2"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![server_id, from, to], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })?;
        for row in rows {
            let (sunday_first, hour, ms) = row?;
            // strftime('%w') is 0 for Sunday; shift so Monday = 0.
            let day = ((sunday_first + 6) % 7) as usize;
            if let Some(cell) = heatmap[day].get_mut(hour as usize) {
                *cell += ms;
            }
        }
    }

    let days = listening_days(conn, server_id, from, to)?;
    let longest_streak = longest_streak(&days);

    let months = {
        let sql = format!(
            "SELECT strftime('%Y-%m', {LOCAL_SECS}, 'unixepoch') AS month, SUM(played_ms), SUM(counted)
             FROM play_history WHERE server_id = ?1 AND started_at >= ?2 AND started_at < ?3
             GROUP BY month ORDER BY month"
        );
        let mut stmt = conn.prepare(&sql)?;
        stmt.query_map(params![server_id, from, to], |r| {
            Ok(MonthStat {
                month: r.get(0)?,
                played_ms: r.get(1)?,
                plays: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    };

    Ok(Summary {
        played_ms,
        plays,
        skips,
        distinct_tracks,
        active_days: days.len() as i64,
        top_tracks,
        top_artists,
        top_albums,
        top_genres,
        heatmap,
        longest_streak,
        discoveries: discoveries(conn, server_id, from, to, top_limit)?,
        months,
    })
}

/// Local day numbers (days since 1970-01-01) with at least one play, ascending.
fn listening_days(
    conn: &Connection,
    server_id: &str,
    from: i64,
    to: i64,
) -> rusqlite::Result<Vec<i64>> {
    // Floor division (SQLite's `/` truncates) so days before 1970 stay correct too.
    let sql = format!(
        "SELECT DISTINCT ({LOCAL_SECS} - (({LOCAL_SECS} % 86400) + 86400) % 86400) / 86400 AS day
         FROM play_history
         WHERE server_id = ?1 AND started_at >= ?2 AND started_at < ?3 AND counted = 1
         ORDER BY day"
    );
    let mut stmt = conn.prepare(&sql)?;
    stmt.query_map(params![server_id, from, to], |r| r.get(0))?
        .collect()
}

fn longest_streak(days: &[i64]) -> Streak {
    let mut best = Streak {
        days: 0,
        start_day: 0,
        end_day: 0,
    };
    let mut run_start = 0;
    let mut previous: Option<i64> = None;
    for &day in days {
        if previous != Some(day - 1) {
            run_start = day;
        }
        let length = day - run_start + 1;
        // `>` keeps the earliest of equally long streaks.
        if length > best.days {
            best = Streak {
                days: length,
                start_day: run_start,
                end_day: day,
            };
        }
        previous = Some(day);
    }
    best
}

fn discoveries(
    conn: &Connection,
    server_id: &str,
    from: i64,
    to: i64,
    top_limit: i64,
) -> rusqlite::Result<Discoveries> {
    // Tracks / artists whose very first play (any time) falls into the range.
    let new_tracks = "SELECT track_id FROM play_history WHERE server_id = ?1 AND counted = 1
                      GROUP BY track_id HAVING MIN(started_at) >= ?2 AND MIN(started_at) < ?3";
    let tracks: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM ({new_tracks})"),
        params![server_id, from, to],
        |r| r.get(0),
    )?;
    let artists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM (
           SELECT 1 FROM play_history WHERE server_id = ?1 AND counted = 1 AND artist <> ''
           GROUP BY COALESCE(artist_id, artist)
           HAVING MIN(started_at) >= ?2 AND MIN(started_at) < ?3)",
        params![server_id, from, to],
        |r| r.get(0),
    )?;
    let extra = Extra {
        filter: format!("AND track_id IN ({new_tracks})"),
        ..Extra::default()
    };
    let top = top_groups(conn, Group::Track, server_id, from, to, top_limit, &extra)?;
    Ok(Discoveries {
        tracks,
        artists,
        top,
    })
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TrackListKind {
    /// Most played in the last 30 days before `now`.
    HeavyRotation,
    /// Played a lot more than ~6 months ago, not at all in the last ~2 months.
    Rediscovered,
    /// Most played inside `[from, to)` (a calendar year or all time).
    Range,
}

/// Ranked local tracks for the automatic playlists. `now` is only used by the two relative kinds.
pub fn track_list(
    conn: &Connection,
    server_id: &str,
    kind: TrackListKind,
    now: i64,
    from: i64,
    to: i64,
    limit: i64,
) -> rusqlite::Result<Vec<StatRow>> {
    match kind {
        TrackListKind::Range => top_groups(
            conn,
            Group::Track,
            server_id,
            from,
            to,
            limit,
            &Extra::default(),
        ),
        TrackListKind::HeavyRotation => {
            let extra = Extra {
                having: format!("AND SUM(counted) >= {HEAVY_ROTATION_MIN_PLAYS}"),
                ..Extra::default()
            };
            top_groups(
                conn,
                Group::Track,
                server_id,
                now - HEAVY_ROTATION_DAYS * DAY_MS,
                now + 1,
                limit,
                &extra,
            )
        }
        TrackListKind::Rediscovered => {
            let extra = Extra {
                having: format!("AND SUM(counted) >= {REDISCOVER_MIN_PLAYS}"),
                // Any play in the quiet period disqualifies the track (?5 = start of that period).
                filter: "AND track_id NOT IN (SELECT track_id FROM play_history
                         WHERE server_id = ?1 AND counted = 1 AND started_at >= ?5)"
                    .to_string(),
                param: Some(now - REDISCOVER_QUIET_DAYS * DAY_MS),
            };
            top_groups(
                conn,
                Group::Track,
                server_id,
                0,
                now - REDISCOVER_OLDER_THAN_DAYS * DAY_MS,
                limit,
                &extra,
            )
        }
    }
}

/// Local calendar years (ascending) in which something was played.
pub fn years(conn: &Connection, server_id: &str) -> rusqlite::Result<Vec<i32>> {
    let sql = format!(
        "SELECT DISTINCT CAST(strftime('%Y', {LOCAL_SECS}, 'unixepoch') AS INTEGER) AS year
         FROM play_history WHERE server_id = ?1 AND counted = 1 ORDER BY year"
    );
    let mut stmt = conn.prepare(&sql)?;
    stmt.query_map(params![server_id], |r| r.get(0))?.collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    const SERVER: &str = "s1";

    /// Unix ms of a UTC date and time (civil-from-days algorithm, no chrono needed).
    fn utc(y: i64, m: i64, d: i64, h: i64, min: i64) -> i64 {
        let y = if m <= 2 { y - 1 } else { y };
        let era = y.div_euclid(400);
        let yoe = y - era * 400;
        let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        let days = era * 146_097 + doe - 719_468;
        ((days * 24 + h) * 60 + min) * 60_000
    }

    fn db() -> Db {
        Db::open_in_memory().unwrap()
    }

    #[derive(Clone)]
    struct P {
        track: &'static str,
        artist: &'static str,
        album: Option<&'static str>,
        genre: Option<&'static str>,
        at: i64,
        ms: i64,
        counted: bool,
        tz: i32,
    }

    fn p(track: &'static str, at: i64) -> P {
        P {
            track,
            artist: "Artist A",
            album: Some("Album 1"),
            genre: Some("Rock"),
            at,
            ms: 200_000,
            counted: true,
            tz: 0,
        }
    }

    fn add(conn: &Connection, x: &P) {
        insert_play(
            conn,
            &NewPlay {
                server_id: SERVER.into(),
                track_id: x.track.into(),
                started_at: x.at,
                played_ms: x.ms,
                duration_ms: 240_000,
                completed: x.counted,
                skipped: !x.counted,
                counted: x.counted,
                context_type: None,
                context_id: None,
                title: format!("Title {}", x.track),
                artist: x.artist.into(),
                artist_id: Some(format!("id-{}", x.artist)),
                album: x.album.map(String::from),
                album_id: x.album.map(|a| format!("id-{a}")),
                genre: x.genre.map(String::from),
                cover: Some(format!("cov-{}", x.track)),
                tz_offset_min: x.tz,
            },
        )
        .unwrap();
    }

    fn all_time(conn: &Connection) -> Summary {
        summary(conn, SERVER, 0, i64::MAX, 10).unwrap()
    }

    #[test]
    fn empty_history_gives_zeroes() {
        let db = db();
        let s = db.with(|c| Ok(all_time(c))).unwrap();
        assert_eq!(s.played_ms, 0);
        assert_eq!(s.plays, 0);
        assert!(s.top_tracks.is_empty());
        assert_eq!(s.longest_streak.days, 0);
        assert_eq!(s.discoveries.tracks, 0);
        assert!(s.months.is_empty());
    }

    #[test]
    fn minutes_count_skips_but_plays_do_not() {
        let db = db();
        let s = db
            .with(|c| {
                add(c, &p("t1", utc(2026, 3, 1, 10, 0)));
                add(
                    c,
                    &P {
                        ms: 10_000,
                        counted: false,
                        ..p("t2", utc(2026, 3, 1, 11, 0))
                    },
                );
                Ok(all_time(c))
            })
            .unwrap();
        assert_eq!(s.played_ms, 210_000);
        assert_eq!(s.plays, 1);
        assert_eq!(s.skips, 1);
        assert_eq!(s.distinct_tracks, 1);
        // A track that was only skipped is not in the top list.
        assert_eq!(s.top_tracks.len(), 1);
        assert_eq!(s.top_tracks[0].id.as_deref(), Some("t1"));
    }

    #[test]
    fn top_lists_rank_by_plays_then_minutes_and_respect_the_range() {
        let db = db();
        db.with(|c| {
            for i in 0..3 {
                add(c, &p("a", utc(2025, 5, 1 + i, 9, 0)));
            }
            for i in 0..2 {
                add(
                    c,
                    &P {
                        artist: "Artist B",
                        album: Some("Album 2"),
                        genre: Some("Jazz"),
                        ..p("b", utc(2026, 1, 1 + i, 9, 0))
                    },
                );
            }
            add(
                c,
                &P {
                    artist: "Artist B",
                    album: Some("Album 2"),
                    genre: Some("Jazz"),
                    ..p("c", utc(2026, 1, 5, 9, 0))
                },
            );
            // Same play count as "c" but more minutes: ranks first of the two.
            add(
                c,
                &P {
                    ms: 900_000,
                    ..p("d", utc(2026, 1, 6, 9, 0))
                },
            );
            Ok(())
        })
        .unwrap();

        let all = db.with(|c| Ok(all_time(c))).unwrap();
        let ids: Vec<_> = all
            .top_tracks
            .iter()
            .map(|r| r.id.clone().unwrap())
            .collect();
        assert_eq!(ids, ["a", "b", "d", "c"]);
        assert_eq!(all.top_artists[0].title, "Artist A");
        assert_eq!(all.top_artists[0].plays, 4);
        assert_eq!(all.top_albums.len(), 2);
        assert_eq!(all.top_genres[0].title, "Rock");
        assert_eq!(all.top_genres[0].plays, 4);

        let year_2026 = db
            .with(|c| summary(c, SERVER, utc(2026, 1, 1, 0, 0), utc(2027, 1, 1, 0, 0), 10))
            .unwrap();
        assert_eq!(year_2026.plays, 4);
        assert_eq!(year_2026.top_tracks[0].id.as_deref(), Some("b"));
        let limited = db.with(|c| summary(c, SERVER, 0, i64::MAX, 2)).unwrap();
        assert_eq!(limited.top_tracks.len(), 2);
    }

    #[test]
    fn tracks_without_album_or_genre_are_left_out_of_those_lists() {
        let db = db();
        let s = db
            .with(|c| {
                add(
                    c,
                    &P {
                        album: None,
                        genre: None,
                        ..p("t", utc(2026, 2, 1, 9, 0))
                    },
                );
                Ok(all_time(c))
            })
            .unwrap();
        assert_eq!(s.top_tracks.len(), 1);
        assert!(s.top_albums.is_empty());
        assert!(s.top_genres.is_empty());
    }

    #[test]
    fn other_servers_are_ignored() {
        let db = db();
        let s = db
            .with(|c| {
                add(c, &p("t", utc(2026, 2, 1, 9, 0)));
                Ok(summary(c, "other", 0, i64::MAX, 10).unwrap())
            })
            .unwrap();
        assert_eq!(s.plays, 0);
    }

    #[test]
    fn heatmap_uses_the_recorded_local_time() {
        let db = db();
        let s = db
            .with(|c| {
                // Sunday 2026-03-01 23:30 UTC at UTC+2 is Monday 01:30 local.
                add(
                    c,
                    &P {
                        tz: 120,
                        ms: 60_000,
                        ..p("t", utc(2026, 3, 1, 23, 30))
                    },
                );
                // Wednesday 2026-03-04 08:10 UTC at UTC-5 is Wednesday 03:10 local.
                add(
                    c,
                    &P {
                        tz: -300,
                        ms: 30_000,
                        ..p("u", utc(2026, 3, 4, 8, 10))
                    },
                );
                Ok(all_time(c))
            })
            .unwrap();
        assert_eq!(s.heatmap[0][1], 60_000, "Monday 01:00");
        assert_eq!(s.heatmap[2][3], 30_000, "Wednesday 03:00");
        let total: i64 = s.heatmap.iter().flatten().sum();
        assert_eq!(total, 90_000);
    }

    #[test]
    fn sunday_ends_up_in_the_last_row() {
        let db = db();
        let s = db
            .with(|c| {
                add(c, &p("t", utc(2026, 3, 1, 12, 0)));
                Ok(all_time(c))
            })
            .unwrap();
        // 2026-03-01 is a Sunday.
        assert_eq!(s.heatmap[6][12], 200_000);
    }

    #[test]
    fn longest_streak_finds_the_longest_run_of_days() {
        let db = db();
        let s = db
            .with(|c| {
                // Run of 3 (Mar 1-3), gap, run of 4 (Mar 6-9), gap, run of 2.
                for d in [1, 2, 3, 6, 7, 8, 9, 12, 13] {
                    add(c, &p("t", utc(2026, 3, d, 12, 0)));
                    // Several plays on one day count once.
                    add(c, &p("u", utc(2026, 3, d, 13, 0)));
                }
                Ok(all_time(c))
            })
            .unwrap();
        assert_eq!(s.longest_streak.days, 4);
        assert_eq!(s.active_days, 9);
        assert_eq!(s.longest_streak.end_day - s.longest_streak.start_day, 3);
        assert_eq!(s.longest_streak.start_day * DAY_MS, utc(2026, 3, 6, 0, 0));
    }

    #[test]
    fn streak_days_follow_local_midnight() {
        let db = db();
        let s = db
            .with(|c| {
                // 23:30 UTC on Mar 1 and 00:30 UTC on Mar 3 are Mar 2 and Mar 3 at UTC+1:
                // two consecutive local days, although UTC has a gap day.
                add(
                    c,
                    &P {
                        tz: 60,
                        ..p("t", utc(2026, 3, 1, 23, 30))
                    },
                );
                add(
                    c,
                    &P {
                        tz: 60,
                        ..p("t", utc(2026, 3, 3, 0, 30))
                    },
                );
                Ok(all_time(c))
            })
            .unwrap();
        assert_eq!(s.longest_streak.days, 2);
    }

    #[test]
    fn skips_do_not_extend_streaks() {
        let db = db();
        let s = db
            .with(|c| {
                add(c, &p("t", utc(2026, 3, 1, 12, 0)));
                add(
                    c,
                    &P {
                        counted: false,
                        ..p("t", utc(2026, 3, 2, 12, 0))
                    },
                );
                Ok(all_time(c))
            })
            .unwrap();
        assert_eq!(s.longest_streak.days, 1);
    }

    #[test]
    fn discoveries_are_tracks_first_played_in_the_range() {
        let db = db();
        let s = db
            .with(|c| {
                add(c, &p("old", utc(2025, 6, 1, 9, 0)));
                add(c, &p("old", utc(2026, 6, 1, 9, 0)));
                for i in 0..2 {
                    add(
                        c,
                        &P {
                            artist: "Artist B",
                            ..p("new", utc(2026, 2, 1 + i, 9, 0))
                        },
                    );
                }
                summary(c, SERVER, utc(2026, 1, 1, 0, 0), utc(2027, 1, 1, 0, 0), 10)
            })
            .unwrap();
        assert_eq!(s.plays, 3);
        assert_eq!(s.discoveries.tracks, 1);
        assert_eq!(s.discoveries.artists, 1);
        assert_eq!(s.discoveries.top.len(), 1);
        assert_eq!(s.discoveries.top[0].id.as_deref(), Some("new"));
    }

    #[test]
    fn months_are_grouped_in_local_time() {
        let db = db();
        let s = db
            .with(|c| {
                add(c, &p("t", utc(2026, 1, 15, 12, 0)));
                add(c, &p("t", utc(2026, 3, 15, 12, 0)));
                add(c, &p("t", utc(2026, 3, 16, 12, 0)));
                // 23:30 UTC on Jan 31 at UTC+2 is February 1st locally.
                add(
                    c,
                    &P {
                        tz: 120,
                        ..p("t", utc(2026, 1, 31, 23, 30))
                    },
                );
                Ok(all_time(c))
            })
            .unwrap();
        let months: Vec<_> = s
            .months
            .iter()
            .map(|m| (m.month.as_str(), m.plays))
            .collect();
        assert_eq!(months, [("2026-01", 1), ("2026-02", 1), ("2026-03", 2)]);
        assert_eq!(s.months[2].played_ms, 400_000);
    }

    #[test]
    fn heavy_rotation_is_the_last_30_days_with_at_least_two_plays() {
        let db = db();
        let now = utc(2026, 6, 30, 12, 0);
        let rows = db
            .with(|c| {
                for i in 0..3 {
                    add(c, &p("hot", now - i * DAY_MS));
                }
                for i in 0..2 {
                    add(c, &p("warm", now - (5 + i) * DAY_MS));
                }
                // Only once: not enough. Old plays do not count.
                add(c, &p("once", now - DAY_MS));
                for i in 0..5 {
                    add(c, &p("old", now - (40 + i) * DAY_MS));
                }
                track_list(c, SERVER, TrackListKind::HeavyRotation, now, 0, 0, 50)
            })
            .unwrap();
        let ids: Vec<_> = rows.iter().map(|r| r.id.clone().unwrap()).collect();
        assert_eq!(ids, ["hot", "warm"]);
    }

    #[test]
    fn rediscovered_needs_old_plays_and_a_quiet_period() {
        let db = db();
        let now = utc(2026, 6, 30, 12, 0);
        let rows = db
            .with(|c| {
                // Classic: five plays 8 months ago, nothing since.
                for i in 0..5 {
                    add(c, &p("forgotten", now - (240 + i) * DAY_MS));
                }
                // Played a lot back then but again last month: not rediscovered, it is current.
                for i in 0..4 {
                    add(c, &p("current", now - (200 + i) * DAY_MS));
                }
                add(c, &p("current", now - 20 * DAY_MS));
                // Not "a lot": two plays only.
                for i in 0..2 {
                    add(c, &p("minor", now - (220 + i) * DAY_MS));
                }
                // Quiet since 3 months (> 2 months): still rediscovered.
                for i in 0..3 {
                    add(c, &p("quiet", now - (210 + i) * DAY_MS));
                }
                add(c, &p("quiet", now - 90 * DAY_MS));
                track_list(c, SERVER, TrackListKind::Rediscovered, now, 0, 0, 50)
            })
            .unwrap();
        let ids: Vec<_> = rows.iter().map(|r| r.id.clone().unwrap()).collect();
        assert_eq!(ids, ["forgotten", "quiet"]);
        assert_eq!(rows[0].plays, 5);
    }

    #[test]
    fn range_track_list_is_the_top_of_the_range() {
        let db = db();
        let rows = db
            .with(|c| {
                add(c, &p("x", utc(2025, 12, 31, 12, 0)));
                add(c, &p("y", utc(2026, 1, 1, 12, 0)));
                add(c, &p("y", utc(2026, 1, 2, 12, 0)));
                track_list(
                    c,
                    SERVER,
                    TrackListKind::Range,
                    0,
                    utc(2026, 1, 1, 0, 0),
                    utc(2027, 1, 1, 0, 0),
                    50,
                )
            })
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id.as_deref(), Some("y"));
        assert_eq!(rows[0].plays, 2);
    }

    #[test]
    fn latest_metadata_wins_in_a_group() {
        let db = db();
        let rows = db
            .with(|c| {
                add(c, &p("t", utc(2026, 1, 1, 12, 0)));
                insert_play(
                    c,
                    &NewPlay {
                        server_id: SERVER.into(),
                        track_id: "t".into(),
                        started_at: utc(2026, 1, 2, 12, 0),
                        played_ms: 200_000,
                        duration_ms: 240_000,
                        completed: true,
                        skipped: false,
                        counted: true,
                        context_type: None,
                        context_id: None,
                        title: "Renamed".into(),
                        artist: "Artist A".into(),
                        artist_id: Some("id-Artist A".into()),
                        album: None,
                        album_id: None,
                        genre: None,
                        cover: None,
                        tz_offset_min: 0,
                    },
                )?;
                track_list(c, SERVER, TrackListKind::Range, 0, 0, i64::MAX, 5)
            })
            .unwrap();
        assert_eq!(rows[0].title, "Renamed");
        assert_eq!(rows[0].plays, 2);
    }

    #[test]
    fn years_lists_local_years_with_plays() {
        let db = db();
        let list = db
            .with(|c| {
                add(c, &p("t", utc(2024, 7, 1, 12, 0)));
                add(c, &p("t", utc(2026, 7, 1, 12, 0)));
                // New Year's Eve 23:30 UTC at UTC+1 is 2026 locally.
                add(
                    c,
                    &P {
                        tz: 60,
                        ..p("t", utc(2026, 12, 31, 23, 30))
                    },
                );
                add(
                    c,
                    &P {
                        tz: 60,
                        ..p("t", utc(2028, 12, 31, 23, 30))
                    },
                );
                years(c, SERVER)
            })
            .unwrap();
        assert_eq!(list, [2024, 2026, 2027, 2029]);
    }
}
