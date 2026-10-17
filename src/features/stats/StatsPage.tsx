import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Flame, Sparkles } from "lucide-react";
import { describeError } from "@/api/errors";
import { useProvider } from "@/api/session";
import { Spinner } from "@/components/ui/Spinner";
import { toastError } from "@/components/ui/toast";
import { RecapYearCard } from "@/features/recap/RecapYearCard";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import i18n from "@/i18n";
import { Heatmap } from "./Heatmap";
import { localDayNumber } from "./heatmapMath";
import { ListeningCalendar } from "./ListeningCalendar";
import { daysAndHours, minutesOf } from "@/features/recap/insights";
import { playRow, playTrackRows } from "./playRows";
import { useHistoryYears, useStatsSummary } from "./queries";
import { rangeBounds, rangeKey, type StatsRange } from "./ranges";
import type { MonthStat, StatRow, Summary } from "./history";
import { fillMonths } from "./months";
import { TopList } from "./TopList";

const MAX_YEAR_TABS = 5;

function Card({ title, children, className }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-lg bg-elevated p-4", className)}>
      {title && <h3 className="mb-3 text-lg font-bold tracking-tight">{title}</h3>}
      {children}
    </section>
  );
}

function Tile({ value, label, hint }: { value: string; label: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-elevated p-4">
      <p className="truncate text-3xl font-extrabold tracking-tight tabular-nums">{value}</p>
      <p className="text-sm text-subdued">{label}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

function MonthBars({ months }: { months: MonthStat[] }) {
  const { t } = useTranslation();
  const filled = fillMonths(months);
  const max = Math.max(...filled.map((m) => m.playedMs), 1);
  const format = new Intl.DateTimeFormat(i18n.language, { month: "short" });
  const label = (key: string) => {
    const [y, m] = key.split("-").map(Number) as [number, number];
    return format.format(new Date(y, m - 1, 1));
  };
  return (
    <div role="img" aria-label={t("stats.monthsChart")}>
      <div className="flex h-32 items-end gap-1.5">
        {filled.map((m) => (
          <div
            key={m.month}
            title={t("stats.monthCell", {
              month: `${label(m.month)} ${m.month.slice(0, 4)}`,
              minutes: formatNumber(minutesOf(m.playedMs)),
            })}
            className="flex-1 rounded-t-[3px] bg-accent accent-fill"
            style={{ height: `${Math.max(m.playedMs > 0 ? 3 : 0, (m.playedMs / max) * 100)}%` }}
          />
        ))}
      </div>
      <div className="mt-1 flex gap-1.5 text-xs text-subdued">
        {filled.map((m) => (
          <span key={m.month} className="flex-1 truncate text-center">
            {label(m.month)}
          </span>
        ))}
      </div>
    </div>
  );
}

const dayFormat = () =>
  new Intl.DateTimeFormat(i18n.language, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
const formatDay = (day: number) => dayFormat().format(new Date(day * 86_400_000));

function Overview({ summary, range }: { summary: Summary; range: StatsRange }) {
  const { t } = useTranslation();
  const { days, hours } = daysAndHours(summary.playedMs);
  return (
    <>
      <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-4">
        <Tile
          value={formatNumber(minutesOf(summary.playedMs))}
          label={t("stats.minutes")}
          hint={
            days > 0
              ? t("stats.minutesHint", { days, hours })
              : hours > 0
                ? t("stats.minutesHintHours", { hours })
                : undefined
          }
        />
        <Tile value={formatNumber(summary.plays)} label={t("stats.plays")} />
        <Tile value={formatNumber(summary.distinctTracks)} label={t("stats.tracks")} />
        <Tile value={formatNumber(summary.activeDays)} label={t("stats.activeDays")} />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Card className="flex items-center gap-4">
          <Flame size={32} className="shrink-0 text-accent" strokeWidth={1.5} />
          <div className="min-w-0">
            <p className="text-sm text-subdued">{t("stats.streak")}</p>
            <p className="text-2xl font-extrabold tracking-tight">
              {t("stats.streakDays", { count: summary.longestStreak.days })}
            </p>
            {summary.longestStreak.days > 0 && (
              <p className="truncate text-xs text-muted">
                {formatDay(summary.longestStreak.startDay)} – {formatDay(summary.longestStreak.endDay)}
              </p>
            )}
          </div>
        </Card>
        {range.kind !== "all" && (
          <Card className="flex items-center gap-4">
            <Sparkles size={32} className="shrink-0 text-accent" strokeWidth={1.5} />
            <div className="min-w-0">
              <p className="text-sm text-subdued">{t("stats.discoveries")}</p>
              <p className="text-2xl font-extrabold tracking-tight">
                {t("stats.discoveryTracks", { count: summary.discoveries.tracks })}
              </p>
              <p className="truncate text-xs text-muted">
                {t("stats.discoveryArtists", { count: summary.discoveries.artists })}
              </p>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}

/** First and last local day of the range for the calendar; "all time" starts at the first listening day. */
function calendarDays(range: StatsRange, summary: Summary): { fromDay: number; toDay: number } {
  const { from, to } = rangeBounds(range);
  const today = localDayNumber(new Date());
  const toDay = Math.min(today, localDayNumber(new Date(to - 1)));
  const fromDay = from === 0 ? (summary.daily[0]?.day ?? toDay) : localDayNumber(new Date(from));
  return { fromDay, toDay };
}

/** Listening statistics from the local history: totals, top lists, calendar, heatmap, streak, months. */
export function StatsPage() {
  const { t } = useTranslation();
  const provider = useProvider();
  const years = useHistoryYears();
  const [range, setRange] = useState<StatsRange>({ kind: "weeks4" });
  const summaryQuery = useStatsSummary(range, 10);

  const currentYear = new Date().getFullYear();
  const yearTabs = useMemo(() => {
    const all = new Set([currentYear, ...(years.data ?? [])]);
    return [...all].sort((a, b) => b - a).slice(0, MAX_YEAR_TABS);
  }, [years.data, currentYear]);
  const tabs: { range: StatsRange; label: string }[] = [
    { range: { kind: "weeks4" }, label: t("stats.range.weeks4") },
    { range: { kind: "months6" }, label: t("stats.range.months6") },
    ...yearTabs.map((year) => ({ range: { kind: "year", year } as StatsRange, label: String(year) })),
    { range: { kind: "all" }, label: t("stats.range.all") },
  ];

  const summary = summaryQuery.data;
  const context = { type: "mix" as const, id: `stats:${rangeKey(range)}`, name: t("stats.topSongs") };
  const guard = (promise: Promise<unknown>) =>
    promise.catch((error: unknown) => toastError(describeError(t, error)));

  return (
    <div className="@container flex flex-col gap-6 px-6 pt-16 pb-10">
      <div>
        <h1 className="text-3xl font-extrabold tracking-tight">{t("stats.title")}</h1>
        <p className="text-subdued">{t("stats.subtitle")}</p>
      </div>

      <div role="tablist" aria-label={t("stats.rangeLabel")} className="flex gap-2 overflow-x-auto pb-1">
        {tabs.map((tab) => {
          const selected = rangeKey(tab.range) === rangeKey(range);
          return (
            <button
              key={rangeKey(tab.range)}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setRange(tab.range)}
              className={cn(
                "h-8 shrink-0 rounded-full px-4 text-sm font-medium transition-colors",
                selected ? "bg-text text-black" : "bg-highlight text-text hover:bg-press",
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {summaryQuery.isPending ? (
        <div className="grid h-64 place-items-center text-subdued">
          <Spinner size={32} />
        </div>
      ) : summaryQuery.isError ? (
        <p className="text-subdued">{describeError(t, summaryQuery.error)}</p>
      ) : !summary || summary.plays === 0 ? (
        <div className="flex flex-col items-center gap-1 py-20 text-center">
          <p className="text-xl font-bold">{t("stats.emptyTitle")}</p>
          <p className="max-w-md text-subdued">{t("stats.emptyText")}</p>
        </div>
      ) : (
        <>
          <Overview summary={summary} range={range} />

          <div className="grid gap-4 @3xl:grid-cols-2">
            <TopList
              title={t("stats.topSongs")}
              kind="track"
              rows={summary.topTracks}
              onPlay={(row: StatRow) => void guard(playTrackRows(provider, summary.topTracks, row, context))}
            />
            <TopList
              title={t("stats.topArtists")}
              kind="artist"
              rows={summary.topArtists}
              onPlay={(row) => playRow(provider, "artist", row)}
            />
            <TopList
              title={t("stats.topAlbums")}
              kind="album"
              rows={summary.topAlbums}
              onPlay={(row) => playRow(provider, "album", row)}
            />
            <TopList title={t("stats.topGenres")} kind="genre" rows={summary.topGenres} />
          </div>

          <Card title={t("stats.calendarTitle")}>
            <ListeningCalendar daily={summary.daily} {...calendarDays(range, summary)} />
          </Card>

          <Card title={t("stats.heatmapTitle")}>
            <Heatmap heatmap={summary.heatmap} />
          </Card>

          {summary.months.length >= 2 && (
            <Card title={t("stats.monthsTitle")}>
              <MonthBars months={summary.months} />
            </Card>
          )}
        </>
      )}

      {(years.data?.length ?? 0) > 0 && (
        <section aria-label={t("stats.recapTitle")}>
          <h2 className="mb-3 text-2xl font-bold tracking-tight">{t("stats.recapTitle")}</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
            {[...(years.data ?? [])]
              .sort((a, b) => b - a)
              .map((year) => (
                <RecapYearCard key={year} year={year} />
              ))}
          </div>
        </section>
      )}
    </div>
  );
}
