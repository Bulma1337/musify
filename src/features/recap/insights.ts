import type { Summary } from "@/features/stats/history";

/** Derived numbers for the Recap slides. Pure functions over a `Summary`. */

export type DayPart = "night" | "morning" | "afternoon" | "evening";

/** Hours (local) belonging to each part of the day; night wraps around midnight. */
export const DAY_PARTS: Record<DayPart, number[]> = {
  morning: [5, 6, 7, 8, 9, 10],
  afternoon: [11, 12, 13, 14, 15, 16],
  evening: [17, 18, 19, 20, 21],
  night: [22, 23, 0, 1, 2, 3, 4],
};

export function hourlyTotals(heatmap: number[][]): number[] {
  return Array.from({ length: 24 }, (_, hour) => heatmap.reduce((sum, row) => sum + (row[hour] ?? 0), 0));
}

export interface TimeOfDay {
  part: DayPart;
  /** Share of listening time in that part, 0..1. */
  share: number;
  peakHour: number;
  hourly: number[];
}

/** The part of the day with the most listening, and the single busiest hour. Null without data. */
export function timeOfDay(heatmap: number[][]): TimeOfDay | null {
  const hourly = hourlyTotals(heatmap);
  const total = hourly.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const parts = (Object.keys(DAY_PARTS) as DayPart[]).map((part) => ({
    part,
    ms: DAY_PARTS[part].reduce((sum, hour) => sum + hourly[hour]!, 0),
  }));
  const best = parts.reduce((a, b) => (b.ms > a.ms ? b : a));
  const peakHour = hourly.indexOf(Math.max(...hourly));
  return { part: best.part, share: best.ms / total, peakHour, hourly };
}

export type PersonalityId =
  "nightOwl" | "earlyBird" | "explorer" | "loyalist" | "genreHopper" | "weekendListener" | "allRounder";

export interface Personality {
  id: PersonalityId;
  /** Numbers behind the verdict, shown as small facts on the slide. */
  metrics: {
    nightShare: number;
    morningShare: number;
    weekendShare: number;
    /** Newly discovered tracks as a share of the distinct tracks played. */
    exploreShare: number;
    /** Plays per distinct track. */
    repeatFactor: number;
    /** Genres with a real share of the listening. */
    genreCount: number;
  };
}

/** Each trait counts when its metric reaches the matching target; the strongest relative score wins. */
const TARGETS = {
  nightOwl: 0.4,
  earlyBird: 0.35,
  explorer: 0.65,
  loyalist: 6,
  genreHopper: 6,
  weekendListener: 0.5,
} as const;

export function derivePersonality(summary: Summary, options: { hasEarlierHistory: boolean }): Personality {
  const hourly = hourlyTotals(summary.heatmap);
  const total = hourly.reduce((a, b) => a + b, 0) || 1;
  const share = (hours: number[]) => hours.reduce((sum, h) => sum + hourly[h]!, 0) / total;
  const weekend =
    [5, 6].reduce((sum, d) => sum + (summary.heatmap[d] ?? []).reduce((a, b) => a + b, 0), 0) / total;
  const genrePlays = summary.topGenres.reduce((sum, g) => sum + g.plays, 0) || 1;

  const metrics: Personality["metrics"] = {
    nightShare: share(DAY_PARTS.night),
    morningShare: share(DAY_PARTS.morning),
    weekendShare: weekend,
    exploreShare: summary.distinctTracks > 0 ? summary.discoveries.tracks / summary.distinctTracks : 0,
    repeatFactor: summary.distinctTracks > 0 ? summary.plays / summary.distinctTracks : 0,
    genreCount: summary.topGenres.filter((g) => g.plays / genrePlays >= 0.05).length,
  };

  // Exploring is meaningless in the first year of history: everything is new.
  const scores: [PersonalityId, number][] = [
    ["nightOwl", metrics.nightShare / TARGETS.nightOwl],
    ["earlyBird", metrics.morningShare / TARGETS.earlyBird],
    ["explorer", options.hasEarlierHistory ? metrics.exploreShare / TARGETS.explorer : 0],
    ["loyalist", metrics.repeatFactor / TARGETS.loyalist],
    ["genreHopper", metrics.genreCount / TARGETS.genreHopper],
    ["weekendListener", metrics.weekendShare / TARGETS.weekendListener],
  ];
  const [id, score] = scores.reduce((a, b) => (b[1] > a[1] ? b : a));
  return { id: score >= 1 ? id : "allRounder", metrics };
}

/** Whole minutes of a duration. */
export const minutesOf = (ms: number) => Math.round(ms / 60000);

/** Days and hours for "that is 3 days and 5 hours of music". */
export function daysAndHours(ms: number): { days: number; hours: number } {
  const totalHours = Math.floor(ms / 3_600_000);
  return { days: Math.floor(totalHours / 24), hours: totalHours % 24 };
}

/** 12 consecutive "YYYY-MM" keys of a calendar year with the minutes of each month (0 when quiet). */
export function monthSeries(summary: Summary, year: number): { month: string; ms: number }[] {
  const byMonth = new Map(summary.months.map((m) => [m.month, m.playedMs]));
  return Array.from({ length: 12 }, (_, i) => {
    const month = `${year}-${String(i + 1).padStart(2, "0")}`;
    return { month, ms: byMonth.get(month) ?? 0 };
  });
}
