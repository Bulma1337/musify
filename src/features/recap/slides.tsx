import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { animate, motion, useReducedMotion, type Variants } from "motion/react";
import {
  Compass,
  Disc3,
  Flame,
  Layers,
  Moon,
  Repeat,
  Sunrise,
  CalendarDays,
  type LucideIcon,
} from "lucide-react";
import { Cover } from "@/components/media/Cover";
import i18n from "@/i18n";
import { formatNumber } from "@/lib/format";
import { seriesPoints, smoothPath } from "./chart";
import type { RecapData, SlideId } from "./model";
import type { PersonalityId } from "./insights";
import type { StatRow } from "@/features/stats/history";

/** Colors come from CSS variables set on the stage (the year's palette). */
const INK = "text-[color:var(--r-ink)]";
const SOFT = "text-[color:var(--r-soft)]";
const ACCENT = "text-[color:var(--r-accent)]";
const PANEL = "bg-[var(--r-panel)]";

const EASE = [0.22, 1, 0.36, 1] as const;

const listVariants: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.09, delayChildren: 0.12 } },
};
const itemVariants: Variants = {
  hidden: { opacity: 0, y: 18 },
  show: { opacity: 1, y: 0, transition: { duration: 0.55, ease: EASE } },
};

/** Counts up to `target` once; shows the final value at once when the user prefers reduced motion. */
function useCountUp(target: number, durationSeconds = 1.6): number {
  const reduced = useReducedMotion();
  const [value, setValue] = useState(reduced ? target : 0);
  useEffect(() => {
    if (reduced) return;
    const controls = animate(0, target, {
      duration: durationSeconds,
      ease: EASE,
      onUpdate: (v) => setValue(Math.round(v)),
      onComplete: () => setValue(target),
    });
    return () => controls.stop();
  }, [target, durationSeconds, reduced]);
  return reduced ? target : value;
}

function Kicker({ children }: { children: ReactNode }) {
  return (
    <motion.p variants={itemVariants} className={`text-sm font-bold tracking-[0.14em] uppercase ${SOFT}`}>
      {children}
    </motion.p>
  );
}

function Headline({ children, size = "lg" }: { children: ReactNode; size?: "lg" | "xl" }) {
  return (
    <motion.h2
      variants={itemVariants}
      className={`font-extrabold tracking-tight text-balance ${INK} ${
        size === "xl"
          ? "text-[clamp(2.5rem,11cqw,5.5rem)] leading-[0.95]"
          : "text-[clamp(1.75rem,6.5cqw,3.25rem)] leading-[1.05]"
      }`}
    >
      {children}
    </motion.h2>
  );
}

function SlideBody({ children }: { children: ReactNode }) {
  return (
    <motion.div
      variants={listVariants}
      initial="hidden"
      animate="show"
      className="flex w-full max-w-2xl flex-col gap-5 text-left"
    >
      {children}
    </motion.div>
  );
}

function BigNumber({ value, label }: { value: string; label?: string }) {
  return (
    <motion.div variants={itemVariants} className="flex flex-col gap-1">
      <span
        className={`font-extrabold tabular-nums leading-none tracking-tight ${ACCENT} text-[clamp(4rem,19cqw,9.5rem)]`}
      >
        {value}
      </span>
      {label && <span className={`text-xl font-semibold ${INK}`}>{label}</span>}
    </motion.div>
  );
}

function RankedRow({
  rank,
  title,
  subtitle,
  plays,
  cover,
  round,
  big,
}: {
  rank: number;
  title: string;
  subtitle?: string | null;
  plays?: number;
  cover?: string | null;
  round?: boolean;
  big?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <motion.li variants={itemVariants} className="flex items-center gap-4">
      <span className={`w-7 shrink-0 text-right text-2xl font-extrabold tabular-nums ${ACCENT}`}>{rank}</span>
      <div className="grid w-[72px] shrink-0 place-items-center">
        <Cover
          cover={cover ?? undefined}
          size={big ? 72 : 52}
          round={round}
          fallback={round ? "artist" : "album"}
          className={big ? "w-[72px] shadow-none" : "w-[52px] shadow-none"}
        />
      </div>
      <div className="min-w-0 flex-1">
        <p className={`truncate font-bold ${INK} ${big ? "text-2xl" : "text-lg"}`} title={title}>
          {title}
        </p>
        {subtitle && <p className={`truncate text-sm ${SOFT}`}>{subtitle}</p>}
      </div>
      {plays !== undefined && (
        <span className={`shrink-0 text-sm tabular-nums ${SOFT}`} title={t("recap.plays", { count: plays })}>
          <span className="@md:hidden">{formatNumber(plays)}</span>
          <span className="hidden @md:inline">{t("recap.plays", { count: plays })}</span>
        </span>
      )}
    </motion.li>
  );
}

function Intro({ data, preview }: { data: RecapData; preview: boolean }) {
  const { t } = useTranslation();
  return (
    <SlideBody>
      <Kicker>{t("recap.slides.intro.kicker")}</Kicker>
      <Headline size="xl">{t("recap.title", { year: data.year })}</Headline>
      <motion.p variants={itemVariants} className={`max-w-md text-lg ${SOFT}`}>
        {t("recap.slides.intro.text")}
      </motion.p>
      {preview && (
        <motion.p
          variants={itemVariants}
          className={`w-fit rounded-full px-4 py-1.5 text-sm font-bold ${PANEL} ${INK}`}
        >
          {t("recap.previewNote")}
        </motion.p>
      )}
    </SlideBody>
  );
}

function Minutes({ data }: { data: RecapData }) {
  const { t } = useTranslation();
  const minutes = useCountUp(data.minutes);
  const stats = [
    { value: data.summary.plays, label: t("recap.slides.minutes.plays") },
    { value: data.summary.distinctTracks, label: t("recap.slides.minutes.tracks") },
    { value: data.summary.activeDays, label: t("recap.slides.minutes.days") },
  ];
  return (
    <SlideBody>
      <Kicker>{t("recap.slides.minutes.kicker")}</Kicker>
      <BigNumber value={formatNumber(minutes)} label={t("recap.slides.minutes.unit")} />
      <motion.p variants={itemVariants} className={`text-lg ${SOFT}`}>
        {t("recap.slides.minutes.detail", { days: data.days, hours: data.hours })}
      </motion.p>
      <motion.ul variants={itemVariants} className="mt-2 grid grid-cols-3 gap-3">
        {stats.map((s) => (
          <li key={s.label} className={`rounded-xl p-3 ${PANEL}`}>
            <p className={`text-2xl font-extrabold tabular-nums ${INK}`}>{formatNumber(s.value)}</p>
            <p className={`text-xs ${SOFT}`}>{s.label}</p>
          </li>
        ))}
      </motion.ul>
    </SlideBody>
  );
}

function TopSong({ data }: { data: RecapData }) {
  const { t } = useTranslation();
  const song = data.topSongs[0]!;
  return (
    <SlideBody>
      <Kicker>{t("recap.slides.topSong.kicker")}</Kicker>
      <motion.div variants={itemVariants} className="flex flex-wrap items-end gap-6">
        <Cover
          cover={song.cover ?? undefined}
          size={200}
          fallback="album"
          className="w-[clamp(120px,32cqw,220px)] shadow-[0_12px_40px_rgb(0_0_0/0.35)]"
          eager
        />
        <div className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
          <h2
            className={`text-[clamp(1.75rem,7cqw,3.5rem)] leading-[1.05] font-extrabold tracking-tight ${INK} break-words`}
          >
            {song.title}
          </h2>
          <p className={`text-xl font-semibold ${SOFT}`}>{song.artist}</p>
          <p className={`mt-2 w-fit rounded-full px-4 py-1.5 text-sm font-bold ${PANEL} ${ACCENT}`}>
            {t("recap.slides.topSong.plays", { count: song.plays })}
          </p>
        </div>
      </motion.div>
    </SlideBody>
  );
}

function RankedSlide({
  kicker,
  headline,
  rows,
  round,
  subtitle,
}: {
  kicker: string;
  headline: string;
  rows: StatRow[];
  round?: boolean;
  subtitle?: (row: StatRow) => string | null;
}) {
  return (
    <SlideBody>
      <Kicker>{kicker}</Kicker>
      <Headline>{headline}</Headline>
      <motion.ol variants={listVariants} className="flex flex-col gap-3">
        {rows.map((row, i) => (
          <RankedRow
            key={`${row.id ?? row.title}-${i}`}
            rank={i + 1}
            title={row.title}
            subtitle={subtitle?.(row)}
            plays={row.plays}
            cover={row.cover}
            round={round}
            big={i === 0}
          />
        ))}
      </motion.ol>
    </SlideBody>
  );
}

function Genres({ data }: { data: RecapData }) {
  const { t } = useTranslation();
  const max = Math.max(...data.genres.map((g) => g.share), 0.01);
  return (
    <SlideBody>
      <Kicker>{t("recap.slides.genres.kicker")}</Kicker>
      <Headline>{t("recap.slides.genres.headline", { genre: data.genres[0]!.row.title })}</Headline>
      <motion.ul variants={listVariants} className="mt-1 flex flex-col gap-4">
        {data.genres.map(({ row, share }) => (
          <motion.li key={row.title} variants={itemVariants} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className={`truncate text-lg font-bold ${INK}`}>{row.title}</span>
              <span className={`text-sm tabular-nums ${SOFT}`}>{Math.round(share * 100)} %</span>
            </div>
            <div className={`h-3 overflow-hidden rounded-full ${PANEL}`}>
              <motion.div
                className="h-full origin-left rounded-full bg-[var(--r-accent)]"
                style={{ width: `${(share / max) * 100}%` }}
                initial={{ scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{ duration: 0.9, ease: EASE, delay: 0.3 }}
              />
            </div>
          </motion.li>
        ))}
      </motion.ul>
    </SlideBody>
  );
}

const PERSONALITY_ICONS: Record<PersonalityId, LucideIcon> = {
  nightOwl: Moon,
  earlyBird: Sunrise,
  explorer: Compass,
  loyalist: Repeat,
  genreHopper: Layers,
  weekendListener: CalendarDays,
  allRounder: Disc3,
};

function Personality({ data }: { data: RecapData }) {
  const { t } = useTranslation();
  const { id, metrics } = data.personality;
  const Icon = PERSONALITY_ICONS[id];
  const facts: Record<PersonalityId, string> = {
    nightOwl: t("recap.slides.personality.factNight", { percent: Math.round(metrics.nightShare * 100) }),
    earlyBird: t("recap.slides.personality.factMorning", { percent: Math.round(metrics.morningShare * 100) }),
    explorer: t("recap.slides.personality.factExplore", { percent: Math.round(metrics.exploreShare * 100) }),
    loyalist: t("recap.slides.personality.factRepeat", {
      value: new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(metrics.repeatFactor),
    }),
    genreHopper: t("recap.slides.personality.factGenres", { count: metrics.genreCount }),
    weekendListener: t("recap.slides.personality.factWeekend", {
      percent: Math.round(metrics.weekendShare * 100),
    }),
    allRounder: t("recap.slides.personality.factAllRounder", { count: metrics.genreCount }),
  };
  return (
    <SlideBody>
      <Kicker>{t("recap.slides.personality.kicker")}</Kicker>
      <motion.div
        variants={itemVariants}
        className={`grid size-20 place-items-center rounded-full ${PANEL} ${ACCENT}`}
      >
        <Icon size={40} strokeWidth={1.5} />
      </motion.div>
      <Headline size="xl">{t(`recap.personality.${id}.name`)}</Headline>
      <motion.p variants={itemVariants} className={`max-w-lg text-lg ${SOFT}`}>
        {t(`recap.personality.${id}.text`)}
      </motion.p>
      <motion.p
        variants={itemVariants}
        className={`w-fit rounded-full px-4 py-1.5 text-sm font-bold ${PANEL} ${INK}`}
      >
        {facts[id]}
      </motion.p>
    </SlideBody>
  );
}

function TimeOfDaySlide({ data }: { data: RecapData }) {
  const { t } = useTranslation();
  const tod = data.timeOfDay!;
  const max = Math.max(...tod.hourly, 1);
  return (
    <SlideBody>
      <Kicker>{t("recap.slides.timeOfDay.kicker")}</Kicker>
      <Headline size="xl">{t(`recap.slides.timeOfDay.part.${tod.part}`)}</Headline>
      <motion.p variants={itemVariants} className={`text-lg ${SOFT}`}>
        {t("recap.slides.timeOfDay.detail", { percent: Math.round(tod.share * 100), hour: tod.peakHour })}
      </motion.p>
      <motion.div
        variants={itemVariants}
        className="mt-2"
        role="img"
        aria-label={t("recap.slides.timeOfDay.chart")}
      >
        <div className="flex h-28 items-end gap-[3px]">
          {tod.hourly.map((ms, hour) => (
            <motion.div
              key={hour}
              className={`flex-1 origin-bottom rounded-t-[3px] ${hour === tod.peakHour ? "bg-[var(--r-accent)]" : "bg-[var(--r-soft)]"}`}
              style={{
                height: `${Math.max(4, (ms / max) * 100)}%`,
                opacity: hour === tod.peakHour ? 1 : 0.55,
              }}
              initial={{ scaleY: 0 }}
              animate={{ scaleY: 1 }}
              transition={{ duration: 0.6, ease: EASE, delay: 0.3 + hour * 0.02 }}
            />
          ))}
        </div>
        <div className={`mt-1 flex justify-between text-xs tabular-nums ${SOFT}`}>
          {[0, 6, 12, 18].map((h) => (
            <span key={h}>{h}</span>
          ))}
          <span>24</span>
        </div>
      </motion.div>
    </SlideBody>
  );
}

const dayNumberFormat = () =>
  new Intl.DateTimeFormat(i18n.language, { day: "numeric", month: "short", timeZone: "UTC" });
const dayOf = (day: number) => dayNumberFormat().format(new Date(day * 86_400_000));

function Streak({ data }: { data: RecapData }) {
  const { t } = useTranslation();
  const days = useCountUp(data.streak.days, 1.2);
  return (
    <SlideBody>
      <Kicker>{t("recap.slides.streak.kicker")}</Kicker>
      <div className="flex items-center gap-4">
        <motion.span variants={itemVariants} className={ACCENT}>
          <Flame size={56} strokeWidth={1.5} />
        </motion.span>
        <BigNumber value={String(days)} label={t("recap.slides.streak.unit", { count: data.streak.days })} />
      </div>
      <motion.p variants={itemVariants} className={`text-lg ${SOFT}`}>
        {t("recap.slides.streak.range", { from: dayOf(data.streak.startDay), to: dayOf(data.streak.endDay) })}
      </motion.p>
    </SlideBody>
  );
}

function Discoveries({ data }: { data: RecapData }) {
  const { t } = useTranslation();
  const { discoveries } = data.summary;
  const count = useCountUp(discoveries.tracks, 1.2);
  const best = discoveries.top[0];
  return (
    <SlideBody>
      <Kicker>{t("recap.slides.discoveries.kicker")}</Kicker>
      <BigNumber
        value={formatNumber(count)}
        label={t("recap.slides.discoveries.unit", { count: discoveries.tracks })}
      />
      {discoveries.artists > 0 && (
        <motion.p variants={itemVariants} className={`text-lg ${SOFT}`}>
          {t("recap.slides.discoveries.artists", { count: discoveries.artists })}
        </motion.p>
      )}
      {best && (
        <motion.div variants={itemVariants} className={`flex items-center gap-4 rounded-2xl p-3 ${PANEL}`}>
          <Cover
            cover={best.cover ?? undefined}
            size={64}
            fallback="album"
            className="size-16 shrink-0 shadow-none"
          />
          <div className="min-w-0">
            <p className={`text-xs font-bold tracking-wider uppercase ${SOFT}`}>
              {t("recap.slides.discoveries.best")}
            </p>
            <p className={`truncate text-lg font-bold ${INK}`}>{best.title}</p>
            <p className={`truncate text-sm ${SOFT}`}>{best.artist}</p>
          </div>
        </motion.div>
      )}
    </SlideBody>
  );
}

function Months({ data }: { data: RecapData }) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const width = 300;
  const height = 120;
  const points = seriesPoints(
    data.months.map((m) => m.ms),
    width,
    height,
  );
  const line = smoothPath(points, 0, height);
  const area = `${line}L${width} ${height}L0 ${height}Z`;
  const peakIndex = data.peakMonth ? data.months.findIndex((m) => m.month === data.peakMonth!.month) : -1;
  const peakPoint = points[peakIndex];
  const long = new Intl.DateTimeFormat(i18n.language, { month: "long" });
  const narrow = new Intl.DateTimeFormat(i18n.language, { month: "narrow" });
  const monthDate = (i: number) => new Date(data.year, i, 1);

  return (
    <SlideBody>
      <Kicker>{t("recap.slides.months.kicker")}</Kicker>
      {data.peakMonth && peakIndex >= 0 && (
        <Headline>
          {t("recap.slides.months.headline", {
            month: long.format(monthDate(peakIndex)),
            minutes: formatNumber(Math.round(data.peakMonth.ms / 60000)),
          })}
        </Headline>
      )}
      <motion.div variants={itemVariants} role="img" aria-label={t("recap.slides.months.chart")}>
        <svg viewBox={`-8 -14 ${width + 16} ${height + 40}`} className="w-full overflow-visible">
          <motion.path
            d={area}
            style={{ fill: "var(--r-accent)" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.18 }}
            transition={{ duration: 0.8, delay: reduced ? 0 : 0.9 }}
          />
          <motion.path
            d={line}
            fill="none"
            strokeWidth={3}
            strokeLinecap="round"
            style={{ stroke: "var(--r-accent)" }}
            initial={{ pathLength: reduced ? 1 : 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 1.4, ease: EASE, delay: 0.25 }}
          />
          {peakPoint && (
            <motion.circle
              cx={peakPoint.x}
              cy={peakPoint.y}
              r={6}
              style={{ fill: "var(--r-ink)", stroke: "var(--r-accent)" }}
              strokeWidth={3}
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: reduced ? 0 : 1.4, type: "spring", stiffness: 300, damping: 18 }}
            />
          )}
          {points.map((p, i) => (
            <text
              key={i}
              x={p.x}
              y={height + 22}
              textAnchor="middle"
              fontSize={11}
              fontWeight={i === peakIndex ? 800 : 500}
              style={{ fill: i === peakIndex ? "var(--r-ink)" : "var(--r-soft)" }}
            >
              {narrow.format(monthDate(i))}
            </text>
          ))}
        </svg>
      </motion.div>
    </SlideBody>
  );
}

function Summary({ data, preview, buttons }: { data: RecapData; preview: boolean; buttons: ReactNode }) {
  const { t } = useTranslation();
  const song = data.topSongs[0];
  const artist = data.topArtists[0];
  const genre = data.genres[0];
  const facts = [
    { label: t("recap.slides.summary.minutes"), value: `${formatNumber(data.minutes)}` },
    artist && { label: t("recap.slides.summary.artist"), value: artist.title },
    genre && { label: t("recap.slides.summary.genre"), value: genre.row.title },
    {
      label: t("recap.slides.summary.personality"),
      value: t(`recap.personality.${data.personality.id}.name`),
    },
  ].filter((f): f is { label: string; value: string } => !!f);
  return (
    <SlideBody>
      <Kicker>{t("recap.slides.summary.kicker")}</Kicker>
      <Headline>{t("recap.title", { year: data.year })}</Headline>
      <motion.div variants={itemVariants} className={`flex flex-col gap-3 rounded-2xl p-4 ${PANEL}`}>
        {song && (
          <div className="flex items-center gap-3">
            <Cover
              cover={song.cover ?? undefined}
              size={56}
              fallback="album"
              className="size-14 shrink-0 shadow-none"
            />
            <div className="min-w-0">
              <p className={`text-xs font-bold tracking-wider uppercase ${SOFT}`}>
                {t("recap.slides.summary.song")}
              </p>
              <p className={`truncate text-lg font-bold ${INK}`}>{song.title}</p>
              <p className={`truncate text-sm ${SOFT}`}>{song.artist}</p>
            </div>
          </div>
        )}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
          {facts.map((f) => (
            <div key={f.label} className="min-w-0">
              <dt className={`text-xs ${SOFT}`}>{f.label}</dt>
              <dd className={`truncate font-bold ${INK}`}>{f.value}</dd>
            </div>
          ))}
        </dl>
      </motion.div>
      <motion.div variants={itemVariants} className="pointer-events-auto flex flex-wrap gap-2">
        {buttons}
      </motion.div>
      {preview && <p className={`text-sm ${SOFT}`}>{t("recap.previewNote")}</p>}
    </SlideBody>
  );
}

export interface SlideProps {
  id: SlideId;
  data: RecapData;
  preview: boolean;
  /** Share and playlist buttons of the closing slide. */
  buttons: ReactNode;
}

/** Renders one slide. Each slide animates its own content in when it mounts. */
export function RecapSlide({ id, data, preview, buttons }: SlideProps) {
  const { t } = useTranslation();
  switch (id) {
    case "intro":
      return <Intro data={data} preview={preview} />;
    case "minutes":
      return <Minutes data={data} />;
    case "topSong":
      return <TopSong data={data} />;
    case "topSongs":
      return (
        <RankedSlide
          kicker={t("recap.slides.topSongs.kicker")}
          headline={t("recap.slides.topSongs.headline")}
          rows={data.topSongs}
          subtitle={(row) => row.artist}
        />
      );
    case "topArtists":
      return (
        <RankedSlide
          kicker={t("recap.slides.topArtists.kicker")}
          headline={t("recap.slides.topArtists.headline", { artist: data.topArtists[0]!.title })}
          rows={data.topArtists}
          round
        />
      );
    case "topAlbums":
      return (
        <RankedSlide
          kicker={t("recap.slides.topAlbums.kicker")}
          headline={t("recap.slides.topAlbums.headline")}
          rows={data.topAlbums}
          subtitle={(row) => row.artist}
        />
      );
    case "genres":
      return <Genres data={data} />;
    case "personality":
      return <Personality data={data} />;
    case "timeOfDay":
      return <TimeOfDaySlide data={data} />;
    case "streak":
      return <Streak data={data} />;
    case "discoveries":
      return <Discoveries data={data} />;
    case "months":
      return <Months data={data} />;
    case "summary":
      return <Summary data={data} preview={preview} buttons={buttons} />;
  }
}
