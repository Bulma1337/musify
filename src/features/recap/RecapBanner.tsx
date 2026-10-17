import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { ArrowRight } from "lucide-react";
import { useHistoryYears } from "@/features/stats/queries";
import { bannerYear } from "./availability";
import { paletteForYear, paletteVars, patternForYear } from "./palette";
import { PatternBackground } from "./PatternBackground";

/** Home page banner in December that points to the current year's Recap (preview or final). */
export function RecapBanner() {
  const { t } = useTranslation();
  const banner = bannerYear();
  const years = useHistoryYears();
  if (!banner || !years.data?.includes(banner.year)) return null;

  const { year, phase } = banner;
  const palette = paletteForYear(year);
  return (
    <Link
      to={`/recap/${year}`}
      style={paletteVars(palette)}
      className="relative block overflow-hidden rounded-xl text-[color:var(--r-ink)] transition-transform hover:scale-[1.005]"
    >
      <PatternBackground palette={palette} kind={patternForYear(year)} year={year} still />
      <div className="relative flex flex-wrap items-center justify-between gap-4 px-6 py-5">
        <div className="min-w-0">
          <p className="text-xs font-bold tracking-[0.14em] text-[color:var(--r-soft)] uppercase">
            {phase === "preview" ? t("recap.banner.previewKicker") : t("recap.banner.finalKicker")}
          </p>
          <p className="text-2xl font-extrabold tracking-tight">{t("recap.banner.title", { year })}</p>
          <p className="text-sm text-[color:var(--r-soft)]">
            {phase === "preview" ? t("recap.banner.previewText") : t("recap.banner.finalText")}
          </p>
        </div>
        <span className="inline-flex h-10 items-center gap-2 rounded-full bg-[var(--r-ink)] px-5 text-sm font-bold text-[color:var(--r-bg)]">
          {t("recap.banner.open")}
          <ArrowRight size={16} />
        </span>
      </div>
    </Link>
  );
}
