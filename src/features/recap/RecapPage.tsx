import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { ChevronLeft, ChevronRight, ImageDown, ListPlus, Play, RotateCcw, Square, X } from "lucide-react";
import { describeError } from "@/api/errors";
import { useProvider } from "@/api/session";
import { Spinner } from "@/components/ui/Spinner";
import { toast, toastError } from "@/components/ui/toast";
import { autoContextId, type AutoRef } from "@/features/autoplaylists/autoPlaylists";
import { autoPlaylistQuery } from "@/features/autoplaylists/queries";
import { saveAutoPlaylist } from "@/features/autoplaylists/saveAuto";
import { useHistoryYears, useStatsSummary } from "@/features/stats/queries";
import { cn } from "@/lib/cn";
import { playOrToggle } from "@/player/actions";
import { recapPhase } from "./availability";
import { buildRecapData, slideIds, type RecapData } from "./model";
import { paletteForYear, paletteVars, patternForYear, type RecapPalette } from "./palette";
import { PatternBackground } from "./PatternBackground";
import { buildShareContent, shareFileName } from "./shareContent";
import { renderRecapPng, type ShareFormat } from "./shareImage";
import { loadCoverBitmap, savePng } from "./saveImage";
import { RecapSlide } from "./slides";

const buttonBase =
  "inline-flex h-10 items-center gap-2 rounded-full px-4 text-sm font-bold transition-[transform,opacity] hover:scale-[1.03] active:scale-95 disabled:pointer-events-none disabled:opacity-50";
const buttonPrimary = `${buttonBase} bg-[var(--r-ink)] text-[color:var(--r-bg)]`;
const buttonSecondary = `${buttonBase} bg-[var(--r-panel)] text-[color:var(--r-ink)] ring-1 ring-[var(--r-soft)]/50`;

function Centered({ palette, year, children }: { palette: RecapPalette; year: number; children: ReactNode }) {
  return (
    <div className="relative h-full min-h-[480px] overflow-hidden" style={paletteVars(palette)}>
      <PatternBackground palette={palette} kind={patternForYear(year)} year={year} />
      <div className="relative z-10 flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
        {children}
      </div>
    </div>
  );
}

export function RecapPage() {
  const { t } = useTranslation();
  const { year: param } = useParams();
  const year = Number(param);
  if (!Number.isInteger(year) || year < 1970 || year > 9999) {
    return <p className="p-6 text-subdued">{t("recap.notFound")}</p>;
  }
  const phase = recapPhase(year);
  if (phase === "locked") {
    const palette = paletteForYear(year);
    return (
      <Centered palette={palette} year={year}>
        <h1 className="text-4xl font-extrabold tracking-tight text-[color:var(--r-ink)]">
          {t("recap.title", { year })}
        </h1>
        <p className="max-w-md text-lg text-[color:var(--r-soft)]">{t("recap.locked", { year })}</p>
        <Link to="/" className={buttonPrimary}>
          {t("recap.backHome")}
        </Link>
      </Centered>
    );
  }
  return <RecapView key={year} year={year} preview={phase === "preview"} />;
}

function RecapView({ year, preview }: { year: number; preview: boolean }) {
  const { t } = useTranslation();
  const summary = useStatsSummary({ kind: "year", year }, 10);
  const years = useHistoryYears();
  const palette = useMemo(() => paletteForYear(year), [year]);
  const data = useMemo(
    () =>
      summary.data
        ? buildRecapData(
            summary.data,
            year,
            (years.data ?? []).some((y) => y < year),
          )
        : null,
    [summary.data, years.data, year],
  );

  if (summary.isPending || years.isPending) {
    return (
      <Centered palette={palette} year={year}>
        <Spinner size={32} className="text-[color:var(--r-soft)]" />
      </Centered>
    );
  }
  if (summary.isError) {
    return (
      <Centered palette={palette} year={year}>
        <p className="text-[color:var(--r-ink)]">{describeError(t, summary.error)}</p>
      </Centered>
    );
  }
  if (!data || data.summary.plays === 0) {
    return (
      <Centered palette={palette} year={year}>
        <h1 className="text-4xl font-extrabold tracking-tight text-[color:var(--r-ink)]">
          {t("recap.title", { year })}
        </h1>
        <p className="max-w-md text-lg text-[color:var(--r-soft)]">{t("recap.empty", { year })}</p>
        <Link to="/" className={buttonPrimary}>
          {t("recap.backHome")}
        </Link>
      </Centered>
    );
  }
  return <Stage data={data} palette={palette} preview={preview} />;
}

function Stage({ data, palette, preview }: { data: RecapData; palette: RecapPalette; preview: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const provider = useProvider();
  const client = useQueryClient();
  const ids = useMemo(() => slideIds(data), [data]);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState<ShareFormat | "playlist" | null>(null);
  const pattern = patternForYear(data.year);
  const last = ids.length - 1;
  const current = ids[Math.min(index, last)]!;
  const auto: AutoRef = { kind: "topYear", year: data.year };
  const topTitle = t("autoPlaylists.title.topYear", { year: data.year });

  const go = useCallback((delta: number) => setIndex((i) => Math.min(last, Math.max(0, i + delta))), [last]);
  const close = useCallback(() => navigate(-1), [navigate]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "ArrowRight") go(1);
      else if (event.key === "ArrowLeft") go(-1);
      else if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, close]);

  async function share(format: ShareFormat) {
    setBusy(format);
    try {
      const cover = await loadCoverBitmap(provider, data.topSongs[0]?.cover);
      const blob = await renderRecapPng({
        format,
        palette,
        pattern,
        content: buildShareContent(data, t),
        cover,
      });
      cover?.close();
      if (await savePng(blob, shareFileName(data.year, format))) toast(t("recap.share.saved"));
    } catch {
      toastError(t("recap.share.failed"));
    } finally {
      setBusy(null);
    }
  }

  async function loadTopSongs() {
    return (await client.fetchQuery(autoPlaylistQuery(provider, auto))).tracks;
  }

  async function savePlaylist() {
    setBusy("playlist");
    try {
      const tracks = await loadTopSongs();
      if (tracks.length === 0) {
        toastError(t("recap.playlist.empty"));
        return;
      }
      await saveAutoPlaylist(provider, client, topTitle, tracks);
      toast(t("autoPlaylists.saved", { name: topTitle }));
    } catch (error) {
      toastError(describeError(t, error));
    } finally {
      setBusy(null);
    }
  }

  const buttons = (
    <>
      <button
        type="button"
        className={buttonPrimary}
        disabled={busy !== null}
        onClick={() => void share("story")}
      >
        {busy === "story" ? <Spinner size={16} /> : <ImageDown size={16} />}
        {t("recap.share.story")}
      </button>
      <button
        type="button"
        className={buttonPrimary}
        disabled={busy !== null}
        onClick={() => void share("square")}
      >
        {busy === "square" ? <Spinner size={16} /> : <Square size={16} />}
        {t("recap.share.square")}
      </button>
      <button
        type="button"
        className={buttonSecondary}
        onClick={() =>
          playOrToggle({ type: "mix", id: autoContextId(auto), name: topTitle }, () => loadTopSongs())
        }
      >
        <Play size={16} fill="currentColor" />
        {t("recap.playlist.play", { year: data.year })}
      </button>
      <button
        type="button"
        className={buttonSecondary}
        disabled={busy !== null}
        onClick={() => void savePlaylist()}
      >
        {busy === "playlist" ? <Spinner size={16} /> : <ListPlus size={16} />}
        {t("recap.playlist.save", { year: data.year })}
      </button>
      <button type="button" className={buttonSecondary} onClick={() => setIndex(0)}>
        <RotateCcw size={16} />
        {t("recap.restart")}
      </button>
    </>
  );

  return (
    <MotionConfig reducedMotion="user">
      <section
        className="@container relative h-full min-h-[520px] overflow-hidden text-[color:var(--r-ink)]"
        style={paletteVars(palette)}
        aria-roledescription="carousel"
        aria-label={t("recap.title", { year: data.year })}
      >
        <PatternBackground palette={palette} kind={pattern} year={data.year} />

        <header className="absolute inset-x-0 top-0 z-30 flex flex-col gap-3 px-6 pt-4">
          <ol className="flex gap-1.5">
            {ids.map((id, i) => (
              <li key={id} className="flex-1">
                <button
                  type="button"
                  aria-label={t("recap.slideOf", { current: i + 1, total: ids.length })}
                  aria-current={i === index ? "step" : undefined}
                  onClick={() => setIndex(i)}
                  className="group block h-4 w-full"
                >
                  <span
                    className={cn(
                      "block h-1 rounded-full transition-opacity",
                      i <= index
                        ? "bg-[var(--r-accent)]"
                        : "bg-[var(--r-soft)] opacity-40 group-hover:opacity-70",
                    )}
                  />
                </button>
              </li>
            ))}
          </ol>
          <div className="flex items-center justify-between">
            <span className="text-sm font-bold tracking-wide text-[color:var(--r-soft)]">
              {t("recap.share.footer")} · {t("recap.title", { year: data.year })}
            </span>
            <button
              type="button"
              aria-label={t("recap.close")}
              title={t("recap.close")}
              onClick={close}
              className="grid size-9 place-items-center rounded-full bg-[var(--r-panel)] text-[color:var(--r-ink)] transition-transform hover:scale-105"
            >
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="absolute inset-0 z-20 overflow-y-auto" aria-live="polite">
          <div className="flex min-h-full items-center justify-center px-10 pt-24 pb-24 @2xl:px-16">
            <AnimatePresence mode="wait">
              <motion.div
                key={current}
                className="flex w-full justify-center"
                initial={{ opacity: 0, x: 24 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -24 }}
                transition={{ duration: 0.25 }}
              >
                <RecapSlide id={current} data={data} preview={preview} buttons={buttons} />
              </motion.div>
            </AnimatePresence>
          </div>
        </div>

        {index > 0 && (
          <button
            type="button"
            aria-label={t("recap.previous")}
            onClick={() => go(-1)}
            className="absolute inset-y-24 left-0.5 z-30 grid w-9 place-items-center @2xl:left-2 @2xl:w-12 rounded-full text-[color:var(--r-soft)] transition-colors hover:text-[color:var(--r-ink)]"
          >
            <ChevronLeft size={32} />
          </button>
        )}
        {index < last && (
          <button
            type="button"
            aria-label={t("recap.next")}
            onClick={() => go(1)}
            className="absolute inset-y-24 right-0.5 z-30 grid w-9 place-items-center @2xl:right-2 @2xl:w-12 rounded-full text-[color:var(--r-soft)] transition-colors hover:text-[color:var(--r-ink)]"
          >
            <ChevronRight size={32} />
          </button>
        )}
      </section>
    </MotionConfig>
  );
}
