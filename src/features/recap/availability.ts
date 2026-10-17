/**
 * When a year's Recap can be opened:
 * - before 1 December of that year: locked
 * - 1 to 30 December: preview (numbers can still change)
 * - from 31 December on, and for every past year: final
 */
export type RecapPhase = "locked" | "preview" | "final";

export function recapPhase(year: number, now: Date = new Date()): RecapPhase {
  if (now < new Date(year, 11, 1)) return "locked";
  if (now < new Date(year, 11, 31)) return "preview";
  return "final";
}

/** The Recap the home page banner advertises: only during December, for the current year. */
export function bannerYear(
  now: Date = new Date(),
): { year: number; phase: Exclude<RecapPhase, "locked"> } | null {
  if (now.getMonth() !== 11) return null;
  const year = now.getFullYear();
  const phase = recapPhase(year, now);
  return phase === "locked" ? null : { year, phase };
}
