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

/** Opacity of a cell: a gentle curve so quiet hours stay visible next to the peak. */
export function cellOpacity(ms: number, max: number): number {
  if (ms <= 0 || max <= 0) return 0;
  return 0.18 + 0.82 * Math.pow(ms / max, 0.6);
}
