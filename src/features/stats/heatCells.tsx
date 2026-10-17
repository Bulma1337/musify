import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import type { HeatLevel } from "./heatmapMath";

const LEVEL_CLASSES: Record<HeatLevel, string> = {
  0: "bg-highlight",
  1: "bg-accent/30",
  2: "bg-accent/55",
  3: "bg-accent/80",
  4: "bg-accent",
};

export function HeatCell({ level, title, className }: { level: HeatLevel; title?: string; className?: string }) {
  return (
    <div
      title={title}
      className={cn("size-3 rounded-[3px] outline-1 -outline-offset-1 outline-white/5", LEVEL_CLASSES[level], className)}
    />
  );
}

/** "Less ▢▢▢▢▢ More". */
export function HeatLegend() {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1 text-xs text-subdued" aria-hidden="true">
      <span className="mr-1">{t("stats.less")}</span>
      {([0, 1, 2, 3, 4] as const).map((level) => (
        <HeatCell key={level} level={level} />
      ))}
      <span className="ml-1">{t("stats.more")}</span>
    </div>
  );
}
