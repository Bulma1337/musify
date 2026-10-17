import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { CircleArrowDown, RotateCw, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useIsOffline, useProvider } from "@/api/session";
import { Cover } from "@/components/media/Cover";
import { MediaCard } from "@/components/media/MediaCard";
import { CardGrid } from "@/components/media/Shelf";
import { TrackList } from "@/components/media/TrackList";
import { Button, IconButton } from "@/components/ui/Button";
import { toastError } from "@/components/ui/toast";
import { usePlayer } from "@/player/store";
import { cancelDownloads, retryAllFailed, retryDownload } from "./actions";
import { errorMessage } from "./errors";
import { formatBytes, percent } from "./format";
import { StorageSettings } from "./StorageSettings";
import { doneEntries, useDownloads, useDownloadsAvailable } from "./store";
import type { CollectionEntry, DownloadEntry } from "./types";

/** Most rows shown in the "in progress" and "failed" lists; the rest is summarized. */
const LIST_LIMIT = 50;

/** Entries in the given states. Entry objects keep their identity until they change. */
function useEntriesIn(states: DownloadEntry["state"][]): DownloadEntry[] {
  return useDownloads(useShallow((s) => Object.values(s.entries).filter((e) => states.includes(e.state))));
}

const DownloadRow = memo(function DownloadRow({ entry, failed }: { entry: DownloadEntry; failed: boolean }) {
  const { t } = useTranslation();
  const provider = useProvider();
  const offline = useIsOffline();
  const { track } = entry;
  const fraction = entry.bytesTotal ? entry.bytesDone / entry.bytesTotal : 0;

  async function run(action: () => Promise<void>) {
    try {
      await action();
    } catch (error) {
      toastError(t("downloads.error", { message: errorMessage(t, error) }));
    }
  }

  let status: string;
  if (entry.state === "failed") status = entry.error ?? t("downloads.state.failed");
  else if (entry.state === "downloading")
    status = t("downloads.state.downloading", { percent: percent(fraction) });
  else status = t("downloads.state.queued");

  return (
    <li className="flex h-14 items-center gap-3 rounded-[4px] px-4 hover:bg-white/10">
      <Cover cover={track.cover} size={40} fallback="track" className="w-10 shadow-none" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-base text-text" title={track.title}>
          {track.title}
        </p>
        <p className="truncate text-sm text-subdued">{track.artistLine}</p>
      </div>
      <div className="flex w-56 items-center justify-end gap-3 text-sm text-subdued">
        {entry.state === "downloading" && (
          <div
            className="h-1 w-24 overflow-hidden rounded-full bg-highlight"
            role="progressbar"
            aria-valuenow={percent(fraction)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="h-full bg-accent accent-fill" style={{ width: `${percent(fraction)}%` }} />
          </div>
        )}
        <span className={failed ? "truncate text-danger" : "tabular-nums"} title={status}>
          {status}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {failed && (
          <IconButton
            label={t("downloads.retry")}
            size={32}
            disabled={offline}
            onClick={() => void run(() => retryDownload(provider, track.id))}
          >
            <RotateCw size={16} />
          </IconButton>
        )}
        <IconButton
          label={failed ? t("downloads.remove") : t("downloads.cancel")}
          size={32}
          onClick={() => void run(() => cancelDownloads(provider.server.id, [track.id]))}
        >
          <X size={18} />
        </IconButton>
      </div>
    </li>
  );
});

function Section({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8">
      <div className="mb-2 flex items-end justify-between gap-4 px-4">
        <h2 className="text-2xl font-bold tracking-tight">
          {title}
          {count != null && <span className="ml-2 text-base font-normal text-subdued">{count}</span>}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function RowList({ items, failed }: { items: DownloadEntry[]; failed: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      <ul>
        {items.slice(0, LIST_LIMIT).map((entry) => (
          <DownloadRow key={entry.track.id} entry={entry} failed={failed} />
        ))}
      </ul>
      {items.length > LIST_LIMIT && (
        <p className="px-4 py-2 text-sm text-subdued">
          {t("common.songs", { count: items.length - LIST_LIMIT })} …
        </p>
      )}
    </>
  );
}

function ActiveSection() {
  const { t } = useTranslation();
  const active = useEntriesIn(["downloading", "queued"]);
  // Running downloads first.
  const sorted = useMemo(
    () => [...active].sort((a, b) => Number(b.state === "downloading") - Number(a.state === "downloading")),
    [active],
  );
  if (sorted.length === 0) return null;
  return (
    <Section title={t("downloads.page.active")} count={sorted.length}>
      <RowList items={sorted} failed={false} />
    </Section>
  );
}

function FailedSection() {
  const { t } = useTranslation();
  const provider = useProvider();
  const offline = useIsOffline();
  const failed = useEntriesIn(["failed"]);
  if (failed.length === 0) return null;
  return (
    <Section
      title={t("downloads.page.failed")}
      count={failed.length}
      action={
        <Button
          variant="secondary"
          size="sm"
          disabled={offline}
          onClick={() =>
            void retryAllFailed(provider).catch((error) =>
              toastError(t("downloads.error", { message: errorMessage(t, error) })),
            )
          }
        >
          {t("downloads.retryAll")}
        </Button>
      }
    >
      <RowList items={failed} failed />
    </Section>
  );
}

function CollectionCard({ collection }: { collection: CollectionEntry }) {
  const { t } = useTranslation();
  const { snapshot } = collection;
  const count = t("common.songs", { count: collection.trackIds.length });
  switch (snapshot.kind) {
    case "album":
      return (
        <MediaCard
          title={collection.name}
          subtitle={`${t("downloads.page.kindAlbum")} • ${snapshot.album.artistLine}`}
          cover={snapshot.album.cover}
          to={`/album/${collection.itemId}`}
        />
      );
    case "playlist":
      return (
        <MediaCard
          title={collection.name}
          subtitle={`${t("downloads.page.kindPlaylist")} • ${count}`}
          cover={snapshot.playlist.cover}
          fallback="playlist"
          to={`/playlist/${collection.itemId}`}
        />
      );
    case "favorites":
      return (
        <MediaCard
          title={collection.name}
          subtitle={`${t("downloads.page.kindFavorites")} • ${count}`}
          fallback="liked"
          to="/liked"
        />
      );
  }
}

function CollectionsSection() {
  const { t } = useTranslation();
  const collections = useDownloads(useShallow((s) => Object.values(s.collections)));
  if (collections.length === 0) return null;
  return (
    <Section title={t("downloads.page.collections")}>
      <CardGrid
        items={collections}
        getKey={(c) => `${c.kind}:${c.itemId}`}
        renderItem={(c) => <CollectionCard collection={c} />}
      />
    </Section>
  );
}

function TracksSection() {
  const { t } = useTranslation();
  // Newest download first. Track objects keep their identity, so progress ticks don't change this list.
  const tracks = useDownloads(
    useShallow((s) =>
      doneEntries(s.entries)
        .reverse()
        .map((e) => e.track),
    ),
  );
  if (tracks.length === 0) return null;
  const context = { type: "mix" as const, name: t("downloads.title") };
  return (
    <Section title={t("downloads.page.tracks")} count={tracks.length}>
      <div className="px-0">
        <TrackList
          tracks={tracks}
          onPlay={(index) => usePlayer.getState().playTracks(tracks, index, context)}
        />
      </div>
    </Section>
  );
}

/** `/downloads`: what is being downloaded, what failed, what is available offline, and the storage overview. */
export function DownloadsPage() {
  const { t } = useTranslation();
  const available = useDownloadsAvailable();
  const offline = useIsOffline();
  const summary = useDownloads(
    useShallow((s) => {
      const all = Object.values(s.entries);
      const done = all.filter((e) => e.state === "done");
      return {
        total: all.length,
        done: done.length,
        bytes: done.reduce((sum, e) => sum + e.sizeBytes, 0),
        collections: Object.keys(s.collections).length,
      };
    }),
  );
  const empty = summary.total === 0 && summary.collections === 0;

  return (
    <div className="px-6 pb-10">
      <header className="flex items-end gap-4 pt-10 pb-2">
        <div className="grid size-16 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
          <CircleArrowDown size={36} />
        </div>
        <div className="min-w-0">
          <h1 className="text-[2rem] leading-tight font-extrabold tracking-tight">{t("downloads.title")}</h1>
          {summary.done > 0 && (
            <p className="text-sm text-subdued">
              {t("downloads.page.summary", { count: summary.done, size: formatBytes(summary.bytes) })}
            </p>
          )}
        </div>
      </header>

      {!available ? (
        <p className="mt-8 text-subdued">{t("downloads.unavailable")}</p>
      ) : empty ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <CircleArrowDown size={48} className="text-subdued" strokeWidth={1.5} />
          <h2 className="text-2xl font-bold tracking-tight">
            {offline ? t("downloads.offline.emptyTitle") : t("downloads.page.emptyTitle")}
          </h2>
          <p className="max-w-sm text-subdued">
            {offline ? t("downloads.offline.emptyHint") : t("downloads.page.emptyHint")}
          </p>
        </div>
      ) : (
        <>
          <ActiveSection />
          <FailedSection />
          <CollectionsSection />
          <TracksSection />
        </>
      )}

      <div className="mt-8 border-t border-divider">
        <StorageSettings />
      </div>
    </div>
  );
}
