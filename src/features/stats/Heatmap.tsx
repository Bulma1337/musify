import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { HeatCell, HeatLegend } from "./heatCells";
import { peakCell, weekdayLabels, heatLevel } from "./heatmapMath";

const HOUR_TICKS = [0, 6, 12, 18];

/** Listening time by weekday and hour of day (local time), 7 x 24 small squares. */
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
      <div className="overflow-x-auto">
        <div
          role="img"
          aria-label={label}
          className="inline-grid gap-[3px]"
          style={{ gridTemplateColumns: "auto repeat(24, 0.75rem)" }}
        >
          <span />
          {Array.from({ length: 24 }, (_, hour) => (
            <span key={hour} className="relative h-4 text-[11px] text-subdued">
              {HOUR_TICKS.includes(hour) && <span className="absolute left-0 whitespace-nowrap">{hour}</span>}
            </span>
          ))}
          {heatmap.map((row, day) => (
            <div key={day} className="contents">
              {/* Every other weekday is labeled, like a contribution graph. */}
              <span className="pr-2 text-[11px] leading-3 text-subdued">
                {day % 2 === 0 ? days[day] : ""}
              </span>
              {row.map((ms, hour) => (
                <HeatCell
                  key={hour}
                  level={heatLevel(ms, max)}
                  title={t("stats.heatmapCell", {
                    day: longDays[day],
                    hour,
                    minutes: Math.round(ms / 60000),
                  })}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <figcaption className="flex flex-wrap items-center justify-between gap-2 text-sm text-subdued">
        <span>{label}</span>
        <HeatLegend />
      </figcaption>
    </figure>
  );
}
