import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { Track } from "@/api/provider";
import { useArtistInfo } from "@/api/queries";
import { Cover } from "@/components/media/Cover";
import { LyricsPreviewCard } from "@/features/lyrics/LyricsPreviewCard";
import { IconButton } from "@/components/ui/Button";
import { Marquee } from "@/components/ui/Marquee";
import { cn } from "@/lib/cn";
import { OutputPanel } from "@/features/output/OutputPanel";
import { formatDate, formatDuration } from "@/lib/format";
import { isLossless, qualityLabel } from "@/player/quality";
import { upcomingContextItems, usePlayer, type QueueItem } from "@/player/store";
import { HistoryView, QueueView } from "@/features/queue/QueuePanel";
import { useLayout } from "./layoutStore";
import { LikeButton } from "./playerControls";

function PanelHeader({ title, children }: { title: string; children?: ReactNode }) {
  const { t } = useTranslation();
  const closeRightPanel = useLayout((s) => s.closeRightPanel);
  return (
    <div className="flex h-14 shrink-0 items-center gap-2 px-4">
      <h2 className="min-w-0 flex-1 truncate font-bold">{title}</h2>
      {children}
      <IconButton label={t("window.close")} onClick={closeRightPanel}>
        <X size={18} />
      </IconButton>
    </div>
  );
}

function Card({ title, children, className }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("overflow-hidden rounded-lg bg-elevated", className)}>
      {title && <h3 className="px-4 pt-4 pb-2 font-bold">{title}</h3>}
      {children}
    </section>
  );
}

/** Removes HTML tags and Last.fm "Read more" links from server biographies. */
function plainBiography(html: string): string {
  const text = new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
  return text.replace(/\s*Read more on Last\.fm\.?\s*$/i, "").trim();
}

/** Artist profiles shown in the panel at most (features and collaborations). */
const MAX_ARTISTS = 4;

function ArtistProfile({ artist, compact }: { artist: { id: string; name: string }; compact: boolean }) {
  const info = useArtistInfo(artist.id);
  const bio = info.data?.biography ? plainBiography(info.data.biography) : undefined;
  return (
    <Link
      to={`/artist/${artist.id}`}
      className="group flex flex-col overflow-hidden rounded-md bg-highlight/50 transition-colors hover:bg-highlight"
    >
      {info.data?.imageUrl ? (
        <img
          src={info.data.imageUrl}
          alt=""
          className={cn("w-full object-cover", compact ? "aspect-[16/9]" : "aspect-[4/3]")}
        />
      ) : (
        <div
          className={cn(
            "w-full bg-gradient-to-br from-accent-soft to-highlight",
            compact ? "aspect-[16/9]" : "aspect-[4/3]",
          )}
        />
      )}
      <div className="flex flex-col gap-1.5 p-3">
        <p className="font-bold group-hover:underline">{artist.name}</p>
        {bio && (
          <p className={cn("text-sm text-subdued", compact ? "line-clamp-3" : "line-clamp-4")}>{bio}</p>
        )}
      </div>
    </Link>
  );
}

/** A profile for every artist of the track, not only the first. */
function ArtistCards({ track }: { track: Track }) {
  const { t } = useTranslation();
  const seen = new Set<string>();
  const artists = track.artists
    .filter((a): a is typeof a & { id: string } => !!a.id && !seen.has(a.id) && !!seen.add(a.id))
    .slice(0, MAX_ARTISTS);
  if (artists.length === 0) return null;
  return (
    <Card title={artists.length > 1 ? t("nowPlaying.aboutArtists") : t("nowPlaying.aboutArtist")}>
      <div className="flex flex-col gap-3 px-4 pb-4">
        {artists.map((artist) => (
          <ArtistProfile key={artist.id} artist={artist} compact={artists.length > 1} />
        ))}
      </div>
    </Card>
  );
}

function CreditsCard({ track }: { track: Track }) {
  const { t } = useTranslation();
  const f = track.format;
  const rows: [string, string | undefined][] = [
    [t("nowPlaying.album"), track.album?.name],
    [t("nowPlaying.year"), track.year?.toString()],
    [t("nowPlaying.genre"), track.genres.join(", ") || undefined],
    [t("nowPlaying.format"), qualityLabel(f) ?? undefined],
    [t("nowPlaying.sampleRate"), f.sampleRate ? `${(f.sampleRate / 1000).toLocaleString()} kHz` : undefined],
    [t("nowPlaying.bitDepth"), f.bitDepth ? `${f.bitDepth} Bit` : undefined],
    [t("nowPlaying.bitRate"), f.bitRate ? `${f.bitRate} kbit/s` : undefined],
    [
      t("nowPlaying.replayGain"),
      track.replayGain?.trackGain !== undefined ? `${track.replayGain.trackGain.toFixed(2)} dB` : undefined,
    ],
    [t("nowPlaying.lastPlayed"), track.lastPlayedAt ? formatDate(track.lastPlayedAt) : undefined],
  ];
  return (
    <Card title={t("nowPlaying.credits")}>
      <dl className="flex flex-col gap-3 px-4 pb-4">
        {rows
          .filter(([, v]) => v)
          .map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-subdued">{label}</dt>
              <dd
                className={cn("text-sm", label === t("nowPlaying.format") && isLossless(f) && "text-accent")}
              >
                {value}
              </dd>
            </div>
          ))}
      </dl>
    </Card>
  );
}

/** All artists of a track, each linking to its page when the server knows it. */
export function ArtistLinks({ track, className }: { track: Track; className?: string }) {
  return (
    <p className={cn("truncate", className)}>
      {track.artists.map((a, i) => (
        <span key={`${a.id ?? a.name}-${i}`}>
          {i > 0 && ", "}
          {a.id ? (
            <Link to={`/artist/${a.id}`} className="hover:text-text hover:underline">
              {a.name}
            </Link>
          ) : (
            a.name
          )}
        </span>
      ))}
    </p>
  );
}

function NowPlayingPanel() {
  const { t } = useTranslation();
  const current = usePlayer((s) => s.current);
  const context = usePlayer((s) => s.context);
  const nextItem = usePlayer((s) => s.manualQueue[0] ?? upcomingContextItems(s)[0]);
  const track = current?.track;

  if (!track) {
    return (
      <>
        <PanelHeader title={t("nowPlaying.title")} />
        <p className="px-4 text-sm text-subdued">{t("nowPlaying.nothing")}</p>
      </>
    );
  }

  return (
    <>
      <PanelHeader title={context?.name ?? t("nowPlaying.title")} />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4 [&>*]:shrink-0">
        <Cover cover={track.cover} size={340} fallback="track" eager className="w-full rounded-lg" />
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <Link
              to={track.album ? `/album/${track.album.id}` : "#"}
              className="block text-2xl font-bold hover:underline"
              title={track.title}
            >
              <Marquee key={track.id}>{track.title}</Marquee>
            </Link>
            <ArtistLinks track={track} className="text-subdued" />
          </div>
          <LikeButton track={track} size={20} />
        </div>
        <LyricsPreviewCard />
        <ArtistCards track={track} />
        <CreditsCard track={track} />
        {nextItem && (
          <Card title={t("nowPlaying.nextInQueue")}>
            <div className="px-2 pb-2">
              <QueueRow item={nextItem} />
            </div>
          </Card>
        )}
      </div>
    </>
  );
}

function QueueRow({ item, current }: { item: QueueItem; current?: boolean }) {
  const t = item.track;
  return (
    <div className="flex items-center gap-3 rounded-md p-2 hover:bg-highlight">
      <Cover cover={t.cover} size={48} fallback="track" className="w-12 shadow-none" />
      <div className="min-w-0 flex-1">
        <p className={cn("truncate", current && "text-accent")}>{t.title}</p>
        <p className="truncate text-sm text-subdued">{t.artistLine}</p>
      </div>
      <span className="text-sm text-subdued tabular-nums">{formatDuration(t.durationMs)}</span>
    </div>
  );
}

function QueuePanel() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"queue" | "history">("queue");
  const tabButton = (value: typeof tab, label: string) => (
    <button
      type="button"
      onClick={() => setTab(value)}
      className={cn(
        "border-b-2 pb-1 text-sm font-bold",
        tab === value ? "border-accent text-text" : "border-transparent text-subdued hover:text-text",
      )}
    >
      {label}
    </button>
  );

  return (
    <>
      <PanelHeader title="">
        <div className="absolute flex gap-4">
          {tabButton("queue", t("queue.title"))}
          {tabButton("history", t("queue.history"))}
        </div>
      </PanelHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {tab === "queue" ? <QueueView /> : <HistoryView />}
      </div>
    </>
  );
}

/** Right side panel: now playing, queue or output devices. */
export function RightPanel() {
  const panel = useLayout((s) => s.rightPanel);
  if (!panel) return null;
  return (
    <aside
      key={panel}
      className="relative flex h-full min-h-0 animate-panel-in flex-col rounded-lg bg-surface"
    >
      {panel === "nowPlaying" && <NowPlayingPanel />}
      {panel === "queue" && <QueuePanel />}
      {panel === "audio" && <OutputPanel />}
    </aside>
  );
}
