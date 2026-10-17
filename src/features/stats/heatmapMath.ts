import i18n from "@/i18n";

/** Short weekday names, Monday first, in the UI language. */
export function weekdayLabels(style: "short" | "long" = "short"): string[] {
  const format = new Intl.DateTimeFormat(i18n.language, { weekday: style });
  // 2024-01-01 was a Monday.
  return Array.from({ length: 7 }, (_, i) => format.format(new Date(2024, 0, 1 + i)));
}

/** The cell with the most listening time, or null for an empty heatmap. */
export function peakCell(heatmap: number[][]): { day: number; hour: number; ms: number } | null {
  let best: { day: number; hour: number; ms: number } | null = null;
  heatmap.forEach((row, day) =>
    row.forEach((ms, hour) => {
      if (ms > 0 && (!best || ms > best.ms)) best = { day, hour, ms };
    }),
  );
  return best;
}

const DAY_MS = 86_400_000;

/** Local day number (days since 1970-01-01, as the history stores it) of a local date. */
export function localDayNumber(date: Date): number {
  return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

/** Monday = 0 … Sunday = 6. Day 0 (1 January 1970) was a Thursday. */
export function weekdayOf(day: number): number {
  return (((day + 3) % 7) + 7) % 7;
}

export interface CalendarDay {
  day: number;
  playedMs: number;
  /** Outside the shown range (padding of the first week, days after the last one). */
  outside: boolean;
}

/** At most this many weeks: a year, like a contribution graph. */
export const CALENDAR_WEEKS = 53;

/**
 * Week columns (Monday first) from `fromDay` to `toDay` (both included), capped to the last
 * {@link CALENDAR_WEEKS} weeks.
 */
export function calendarWeeks(
  daily: readonly { day: number; playedMs: number }[],
  fromDay: number,
  toDay: number,
): CalendarDay[][] {
  const start = Math.max(fromDay, toDay - weekdayOf(toDay) - (CALENDAR_WEEKS - 1) * 7);
  const firstMonday = start - weekdayOf(start);
  const byDay = new Map(daily.map((d) => [d.day, d.playedMs]));
  const weeks: CalendarDay[][] = [];
  for (let monday = firstMonday; monday <= toDay; monday += 7) {
    weeks.push(
      Array.from({ length: 7 }, (_, i) => {
        const day = monday + i;
        return { day, playedMs: byDay.get(day) ?? 0, outside: day < start || day > toDay };
      }),
    );
  }
  return weeks;
}

/** The date of a local day number, for formatting with `timeZone: "UTC"`. */
export function dateOfDay(day: number): Date {
  return new Date(day * DAY_MS);
}

/** Five steps like a contribution graph: nothing, then four shades of the accent. */
export type HeatLevel = 0 | 1 | 2 | 3 | 4;

/** Level of a value next to the largest one; a square root keeps quiet cells apart from empty ones. */
export function heatLevel(value: number, max: number): HeatLevel {
  if (value <= 0 || max <= 0) return 0;
  const r = Math.sqrt(value / max);
  if (r > 0.75) return 4;
  if (r > 0.5) return 3;
  if (r > 0.25) return 2;
  return 1;
}
