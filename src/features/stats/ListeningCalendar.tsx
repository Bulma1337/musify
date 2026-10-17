import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { DayStat } from "./history";
import { HeatCell, HeatLegend } from "./heatCells";
import { calendarWeeks, dateOfDay, weekdayLabels, heatLevel } from "./heatmapMath";

/** One square per day, a column per week, like a contribution graph (at most the last year). */
export function ListeningCalendar({
  daily,
  fromDay,
  toDay,
}: {
  daily: DayStat[];
  /** First and last local day numbers of the range (both included). */
  fromDay: number;
  toDay: number;
}) {
  const { t, i18n } = useTranslation();
  const weeks = useMemo(() => calendarWeeks(daily, fromDay, toDay), [daily, fromDay, toDay]);
  const days = useMemo(() => weekdayLabels(), []);
  const formats = useMemo(
    () => ({
      month: new Intl.DateTimeFormat(i18n.language, { month: "short", timeZone: "UTC" }),
      date: new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeZone: "UTC" }),
    }),
    [i18n.language],
  );
  const shown = weeks.flat().filter((d) => !d.outside);
  const max = Math.max(0, ...shown.map((d) => d.playedMs));
  const activeDays = shown.filter((d) => d.playedMs > 0).length;

  // A month label above the first week that starts in that month.
  const monthLabels = weeks.map((week, i) => {
    const first = week.find((d) => !d.outside) ?? week[0]!;
    const month = dateOfDay(first.day).getUTCMonth();
    const previous = i > 0 ? dateOfDay((weeks[i - 1]!.find((d) => !d.outside) ?? weeks[i - 1]![0]!).day).getUTCMonth() : -1;
    return month !== previous ? formats.month.format(dateOfDay(first.day)) : "";
  });

  return (
    <figure className="flex flex-col gap-3" aria-label={t("stats.calendarTitle")}>
      <div className="overflow-x-auto pb-1">
        <div
          role="img"
          aria-label={t("stats.calendarSummary", { count: activeDays })}
          className="inline-grid grid-flow-col gap-[3px]"
          style={{ gridTemplateRows: "1rem repeat(7, 0.75rem)", gridTemplateColumns: `auto repeat(${weeks.length}, 0.75rem)` }}
        >
          <span />
          {days.map((label, i) => (
            <span key={i} className="pr-2 text-[11px] leading-3 text-subdued">
              {i % 2 === 0 ? label : ""}
            </span>
          ))}
          {weeks.map((week, w) => (
            <div key={week[0]!.day} className="contents">
              <span className="relative text-[11px] text-subdued">
                {monthLabels[w] && <span className="absolute left-0 whitespace-nowrap">{monthLabels[w]}</span>}
              </span>
              {week.map((d) =>
                d.outside ? (
                  <span key={d.day} />
                ) : (
                  <HeatCell
                    key={d.day}
                    level={heatLevel(d.playedMs, max)}
                    title={t("stats.calendarCell", {
                      date: formats.date.format(dateOfDay(d.day)),
                      minutes: Math.round(d.playedMs / 60000),
                    })}
                  />
                ),
              )}
            </div>
          ))}
        </div>
      </div>
      <figcaption className="flex flex-wrap items-center justify-between gap-2 text-sm text-subdued">
        <span>{t("stats.calendarSummary", { count: activeDays })}</span>
        <HeatLegend />
      </figcaption>
    </figure>
  );
}
