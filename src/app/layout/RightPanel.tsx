import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Heart, Laptop, X } from "lucide-react";
import type { Track } from "@/api/provider";
import { useArtistInfo, useSetStarred } from "@/api/queries";
import { Cover } from "@/components/media/Cover";
import { IconButton } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { formatDate, formatDuration } from "@/lib/format";
import { isLossless, qualityLabel } from "@/player/quality";
import { upcomingContextItems, usePlayer, type QueueItem } from "@/player/store";
import { useLayout } from "./layoutStore";

function PanelHeader({ title, children }: { title: string; children?: ReactNode }) {
  const { t } = useTranslation();
  const setRightPanel = useLayout((s) => s.setRightPanel);
  return (
    <div className="flex h-14 shrink-0 items-center gap-2 px-4">
      <h2 className="min-w-0 flex-1 truncate font-bold">{title}</h2>
      {children}
      <IconButton label={t("window.close")} onClick={() => setRightPanel(null)}>
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

function ArtistCard({ track }: { track: Track }) {
  const { t } = useTranslation();
  const artist = track.artists[0];
  const info = useArtistInfo(artist?.id);
  if (!artist?.id) return null;
  const bio = info.data?.biography ? plainBiography(info.data.biography) : undefined;

  return (
    <Card>
      <Link to={`/artist/${artist.id}`} className="group block">
        <div className="relative">
          {info.data?.imageUrl ? (
            <img src={info.data.imageUrl} alt="" className="aspect-[4/3] w-full object-cover" />
          ) : (
            <div className="aspect-[4/3] w-full bg-gradient-to-br from-accent-soft to-highlight" />
          )}
          <span className="absolute top-4 left-4 font-bold drop-shadow-[0_1px_4px_rgb(0_0_0/0.8)]">
            {t("nowPlaying.aboutArtist")}
          </span>
        </div>
        <div className="flex flex-col gap-2 p-4">
          <p className="font-bold group-hover:underline">{artist.name}</p>
          {bio && <p className="line-clamp-4 text-sm text-subdued">{bio}</p>}
        </div>
      </Link>
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

function NowPlayingPanel() {
  const { t } = useTranslation();
  const current = usePlayer((s) => s.current);
  const context = usePlayer((s) => s.context);
  const nextItem = usePlayer((s) => s.manualQueue[0] ?? upcomingContextItems(s)[0]);
  const setStarred = useSetStarred();
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
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
        <Cover cover={track.cover} size={340} fallback="track" eager className="w-full rounded-lg" />
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <Link
              to={track.album ? `/album/${track.album.id}` : "#"}
              className="block truncate text-2xl font-bold hover:underline"
            >
              {track.title}
            </Link>
            <p className="truncate text-subdued">{track.artistLine}</p>
          </div>
          <IconButton
            label={track.starred ? t("menu.removeFromLiked") : t("menu.addToLiked")}
            active={track.starred}
            onClick={() => setStarred.mutate({ kind: "track", id: track.id, starred: !track.starred })}
          >
            <Heart size={20} className={track.starred ? "fill-current" : ""} />
          </IconButton>
        </div>
        <ArtistCard track={track} />
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
  const current = usePlayer((s) => s.current);
  const manual = usePlayer((s) => s.manualQueue);
  const context = usePlayer((s) => s.context);
  const history = usePlayer((s) => s.history);
  const upcoming = usePlayer(upcomingContextItems);

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
        {tab === "queue" ? (
          <>
            {current && (
              <section>
                <h3 className="px-2 pt-2 pb-1 font-bold">{t("queue.nowPlaying")}</h3>
                <QueueRow item={current} current />
              </section>
            )}
            {manual.length > 0 && (
              <section>
                <h3 className="px-2 pt-4 pb-1 font-bold">{t("queue.nextInQueue")}</h3>
                {manual.map((item) => (
                  <QueueRow key={item.key} item={item} />
                ))}
              </section>
            )}
            {upcoming.length > 0 && (
              <section>
                <h3 className="truncate px-2 pt-4 pb-1 font-bold">
                  {t("queue.nextFrom", { name: context?.name ?? "" })}
                </h3>
                {upcoming.slice(0, 100).map((item) => (
                  <QueueRow key={item.key} item={item} />
                ))}
              </section>
            )}
            {!current && <p className="px-2 pt-2 text-sm text-subdued">{t("queue.empty")}</p>}
          </>
        ) : history.length > 0 ? (
          history.map((item) => <QueueRow key={item.key} item={item} />)
        ) : (
          <p className="px-2 pt-2 text-sm text-subdued">{t("queue.historyEmpty")}</p>
        )}
      </div>
    </>
  );
}

function DevicesPanel() {
  const { t } = useTranslation();
  return (
    <>
      <PanelHeader title={t("devices.title")} />
      <div className="px-4">
        <div className="flex items-center gap-3 rounded-lg bg-elevated p-4">
          <Laptop size={28} className="text-accent" />
          <div>
            <p className="font-bold text-accent">{t("devices.thisComputer")}</p>
            <p className="text-sm text-subdued">{t("devices.systemDefault")}</p>
          </div>
        </div>
      </div>
    </>
  );
}

/** Right side panel: now playing, queue or output devices. */
export function RightPanel() {
  const panel = useLayout((s) => s.rightPanel);
  if (!panel) return null;
  return (
    <aside className="relative flex h-full min-h-0 flex-col rounded-lg bg-surface">
      {panel === "nowPlaying" && <NowPlayingPanel />}
      {panel === "queue" && <QueuePanel />}
      {panel === "devices" && <DevicesPanel />}
    </aside>
  );
}
