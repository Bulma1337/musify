import { recapPhase } from "@/features/recap/availability";
import { localDayNumber } from "@/features/stats/heatmapMath";
import { useStatsSummary } from "@/features/stats/queries";
import type { AutoPlaylistPrefs } from "@/settings/homeLayout";
import type { AutoRef } from "./autoPlaylists";

/**
 * Days of local history a list needs before it means anything: "heavy rotation" covers 30 days,
 * "rediscovered" looks for favorites not played for a while.
 */
export const MIN_HISTORY_DAYS = { heavyRotation: 14, rediscovered: 60 } as const;

/**
 * Whether an automatic playlist may be offered: switched on, enough history, and a year's top songs
 * only once that year's Recap is out (from 1 December; past years always).
 */
export function autoPlaylistAllowed(
  ref: AutoRef,
  prefs: AutoPlaylistPrefs,
  historyDays: number,
  now: Date = new Date(),
): boolean {
  if (!prefs.enabled || !prefs[ref.kind]) return false;
  switch (ref.kind) {
    case "heavyRotation":
      return historyDays >= MIN_HISTORY_DAYS.heavyRotation;
    case "rediscovered":
      return historyDays >= MIN_HISTORY_DAYS.rediscovered;
    case "topYear":
      return recapPhase(ref.year ?? now.getFullYear(), now) !== "locked";
    case "allTime":
      return true;
  }
}

/** Days since the first play in the local history (0 without history). */
export function useHistoryDays(): number {
  const summary = useStatsSummary({ kind: "all" }, 1);
  const first = summary.data?.daily[0]?.day;
  return first === undefined ? 0 : localDayNumber(new Date()) - first + 1;
}
