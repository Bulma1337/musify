import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { recapPhase } from "./availability";
import { paletteForYear, paletteVars, patternForYear } from "./palette";
import { PatternBackground } from "./PatternBackground";

/** Archive tile for one year's Recap (stats page). Years that have not started yet are not clickable. */
export function RecapYearCard({ year }: { year: number }) {
  const { t } = useTranslation();
  const palette = paletteForYear(year);
  const phase = recapPhase(year);
  const content = (
    <>
      <PatternBackground palette={palette} kind={patternForYear(year)} year={year} still />
      <div className="relative flex h-full flex-col justify-end p-4">
        <p className="text-xs font-bold tracking-[0.14em] text-[color:var(--r-soft)] uppercase">
          {phase === "final"
            ? t("recap.archive.final")
            : phase === "preview"
              ? t("recap.archive.preview")
              : t("recap.archive.locked")}
        </p>
        <p className="text-xl font-extrabold tracking-tight">{t("recap.title", { year })}</p>
      </div>
    </>
  );
  const className =
    "relative block aspect-[4/3] min-w-0 overflow-hidden rounded-lg text-[color:var(--r-ink)] transition-transform";
  return phase === "locked" ? (
    <div style={paletteVars(palette)} className={`${className} opacity-70`} aria-disabled="true">
      {content}
    </div>
  ) : (
    <Link to={`/recap/${year}`} style={paletteVars(palette)} className={`${className} hover:scale-[1.02]`}>
      {content}
    </Link>
  );
}
