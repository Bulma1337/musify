import type { StatRow, Streak, Summary } from "@/features/stats/history";
import {
  daysAndHours,
  derivePersonality,
  minutesOf,
  monthSeries,
  timeOfDay,
  type Personality,
  type TimeOfDay,
} from "./insights";

export type SlideId =
  | "intro"
  | "minutes"
  | "topSong"
  | "topSongs"
  | "topArtists"
  | "topAlbums"
  | "genres"
  | "personality"
  | "timeOfDay"
  | "streak"
  | "discoveries"
  | "months"
  | "summary";

export interface RecapData {
  year: number;
  summary: Summary;
  minutes: number;
  days: number;
  hours: number;
  topSongs: StatRow[];
  topArtists: StatRow[];
  topAlbums: StatRow[];
  /** Top genres with their share (0..1) of all genre-tagged plays. */
  genres: { row: StatRow; share: number }[];
  personality: Personality;
  timeOfDay: TimeOfDay | null;
  months: { month: string; ms: number }[];
  peakMonth: { month: string; ms: number } | null;
  streak: Streak;
  hasEarlierHistory: boolean;
}

const TOP = 5;

export function buildRecapData(summary: Summary, year: number, hasEarlierHistory: boolean): RecapData {
  const genrePlays = summary.topGenres.reduce((sum, g) => sum + g.plays, 0) || 1;
  const months = monthSeries(summary, year);
  const peak = months.reduce((a, b) => (b.ms > a.ms ? b : a), months[0]!);
  return {
    year,
    summary,
    minutes: minutesOf(summary.playedMs),
    ...daysAndHours(summary.playedMs),
    topSongs: summary.topTracks.slice(0, TOP),
    topArtists: summary.topArtists.slice(0, TOP),
    topAlbums: summary.topAlbums.slice(0, TOP),
    genres: summary.topGenres.slice(0, TOP).map((row) => ({ row, share: row.plays / genrePlays })),
    personality: derivePersonality(summary, { hasEarlierHistory }),
    timeOfDay: timeOfDay(summary.heatmap),
    months,
    peakMonth: peak.ms > 0 ? peak : null,
    streak: summary.longestStreak,
    hasEarlierHistory,
  };
}

/** The slides to show, in order. Slides without enough data are left out. */
export function slideIds(data: RecapData): SlideId[] {
  const ids: SlideId[] = ["intro", "minutes"];
  if (data.topSongs.length >= 1) ids.push("topSong");
  if (data.topSongs.length >= 2) ids.push("topSongs");
  if (data.topArtists.length >= 1) ids.push("topArtists");
  if (data.topAlbums.length >= 1) ids.push("topAlbums");
  if (data.genres.length >= 1) ids.push("genres");
  ids.push("personality");
  if (data.timeOfDay) ids.push("timeOfDay");
  if (data.streak.days >= 2) ids.push("streak");
  if (data.hasEarlierHistory && data.summary.discoveries.tracks >= 1) ids.push("discoveries");
  if (data.months.filter((m) => m.ms > 0).length >= 2) ids.push("months");
  ids.push("summary");
  return ids;
}
