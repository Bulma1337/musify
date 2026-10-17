/** Time ranges offered by the Stats page. Bounds are half-open `[from, to)` in Unix ms. */
export type RangeKind = "weeks4" | "months6" | "year" | "all";

export interface StatsRange {
  kind: RangeKind;
  /** Calendar year for `kind: "year"`. */
  year?: number;
}

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

/**
 * Bounds in the user's local calendar. They are aligned to local midnight so the same range keeps
 * the same cache key all day.
 */
export function rangeBounds(range: StatsRange, now: Date = new Date()): { from: number; to: number } {
  const today = startOfDay(now);
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).getTime();
  switch (range.kind) {
    case "weeks4":
      return {
        from: new Date(today.getFullYear(), today.getMonth(), today.getDate() - 27).getTime(),
        to: tomorrow,
      };
    case "months6":
      return {
        from: new Date(today.getFullYear(), today.getMonth() - 6, today.getDate()).getTime(),
        to: tomorrow,
      };
    case "year": {
      const year = range.year ?? now.getFullYear();
      return { from: new Date(year, 0, 1).getTime(), to: new Date(year + 1, 0, 1).getTime() };
    }
    case "all":
      return { from: 0, to: tomorrow };
  }
}

export function rangeKey(range: StatsRange): string {
  return range.kind === "year" ? `year-${range.year ?? new Date().getFullYear()}` : range.kind;
}
