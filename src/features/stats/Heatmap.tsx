import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { cellOpacity, peakCell, weekdayLabels } from "./heatmapMath";

const HOUR_TICKS = [0, 6, 12, 18];

/** Listening time by weekday and hour of day (local time), as a 7 x 24 grid. */
export function Heatmap({ heatmap }: { heatmap: number[][] }) {
  const { t } = useTranslation();
  const days = useMemo(() => weekdayLabels(), []);
  const longDays = useMemo(() => weekdayLabels("long"), []);
  const max = Math.max(0, ...heatmap.flat());
  const peak = peakCell(heatmap);
  const label = peak
    ? t("stats.heatmapPeak", { day: longDays[peak.day], hour: peak.hour })
    : t("stats.heatmapEmpty");

  return (
    <figure className="flex flex-col gap-3" aria-label={t("stats.heatmapTitle")}>
      <div
        role="img"
        aria-label={label}
        className="grid gap-[3px]"
        style={{ gridTemplateColumns: "auto repeat(24, minmax(0, 1fr))" }}
      >
        {heatmap.map((row, day) => (
          <div key={day} className="contents">
            <span className="pr-2 text-xs leading-5 text-subdued">{days[day]}</span>
            {row.map((ms, hour) => (
              <div
                key={hour}
                title={t("stats.heatmapCell", {
                  day: longDays[day],
                  hour,
                  minutes: Math.round(ms / 60000),
                })}
                className={
                  ms > 0
                    ? "aspect-square rounded-[3px] bg-accent"
                    : "aspect-square rounded-[3px] bg-highlight"
                }
                style={ms > 0 ? { opacity: cellOpacity(ms, max) } : undefined}
              />
            ))}
          </div>
        ))}
        <span />
        {Array.from({ length: 24 }, (_, hour) => (
          <span key={hour} className="relative h-4 text-xs text-subdued">
            {HOUR_TICKS.includes(hour) && <span className="absolute left-0 whitespace-nowrap">{hour}</span>}
          </span>
        ))}
      </div>
      <figcaption className="text-sm text-subdued">{label}</figcaption>
    </figure>
  );
}
