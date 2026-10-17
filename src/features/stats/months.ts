import type { MonthStat } from "./history";

/** Calendar months between the first and last month of the data, so quiet months show as gaps. */
export function fillMonths(months: MonthStat[]): MonthStat[] {
  if (months.length === 0) return [];
  const byMonth = new Map(months.map((m) => [m.month, m]));
  const [firstYear, firstMonth] = months[0]!.month.split("-").map(Number) as [number, number];
  const [lastYear, lastMonth] = months.at(-1)!.month.split("-").map(Number) as [number, number];
  const result: MonthStat[] = [];
  let y = firstYear;
  let m = firstMonth;
  while (y < lastYear || (y === lastYear && m <= lastMonth)) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    result.push(byMonth.get(key) ?? { month: key, playedMs: 0, plays: 0 });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return result;
}
