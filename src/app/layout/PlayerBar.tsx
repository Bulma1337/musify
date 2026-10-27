import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import {
  ListMusic,
  Maximize2,
  MicVocal,
  MonitorSpeaker,
  PanelRight,
  PictureInPicture2,
  Speaker,
  Tv,
} from "lucide-react";
import { useLyricsRoute } from "@/features/lyrics/useLyricsRoute";
import { Cover } from "@/components/media/Cover";
import { IconButton } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { useNetwork } from "@/player/network";
import { isLossless, qualityLabel } from "@/player/quality";
import { usePlayer } from "@/player/store";
import { useLayout } from "./layoutStore";
import { LikeButton, ProgressRow, TransportButtons, VolumeControl } from "./playerControls";
import { usePlayerView } from "./playerView";

function NowPlayingInfo() {
  const { t } = useTranslation();
  const track = usePlayer((s) => s.current?.track);
  const audioOpen = useLayout((s) => s.rightPanel === "audio");
  const toggleRightPanel = useLayout((s) => s.toggleRightPanel);
  if (!track) return <div className="min-w-0 flex-1" />;
  const quality = qualityLabel(track.format);

  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <Link to={track.album ? `/album/${track.album.id}` : "#"} className="shrink-0">
        <Cover cover={track.cover} size={56} fallback="track" className="w-14 shadow-none" />
      </Link>
      <div className="min-w-0">
        <Link
          to={track.album ? `/album/${track.album.id}` : "#"}
          className="block truncate text-sm font-semibold hover:underline"
          title={track.title}
        >
          {track.title}
        </Link>
        <p className="truncate text-xs text-subdued">
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
        {quality && (
          <button
            type="button"
            aria-label={t("player.formatAndSound", { format: quality })}
            title={t("player.formatAndSound", { format: quality })}
            aria-pressed={audioOpen}
            onClick={() => toggleRightPanel("audio")}
            className={cn(
              "block text-[11px] font-semibold underline-offset-2 hover:underline",
              isLossless(track.format) ? "text-accent" : "text-subdued hover:text-text",
            )}
          >
            {quality}
          </button>
        )}
      </div>
      <div className="ml-1">
        <LikeButton track={track} />
      </div>
    </div>
  );
}

function Transport() {
  return (
    <div className="flex w-[40%] max-w-[722px] flex-col items-center gap-1">
      <TransportButtons />
      <ProgressRow />
    </div>
  );
}

/** Shown under the player bar while a network speaker plays; opens the audio panel. */
function SpeakerStrip() {
  const { t } = useTranslation();
  const device = useNetwork((s) => s.active?.device ?? null);
  const toggleRightPanel = useLayout((s) => s.toggleRightPanel);
  if (!device) return null;
  const Icon = device.kind === "tv" ? Tv : Speaker;
  return (
    <button
      type="button"
      onClick={() => toggleRightPanel("audio")}
      className="flex h-6 shrink-0 items-center justify-end gap-1.5 bg-accent px-4 text-xs font-bold text-on-accent accent-fill"
      data-testid="speaker-strip"
    >
      <Icon size={14} aria-hidden="true" />
      {t("output.network.playingOn", { name: device.name })}
    </button>
  );
}

/** Bottom player bar: now playing, transport with progress, and panel/volume controls. */
export function PlayerBar() {
  const { t } = useTranslation();
  const rightPanel = useLayout((s) => s.rightPanel);
  const toggleRightPanel = useLayout((s) => s.toggleRightPanel);
  const lyricsRoute = useLyricsRoute();
  const openMini = usePlayerView((st) => st.openMini);
  const openFullscreen = usePlayerView((st) => st.openFullscreen);
  const onSpeaker = useNetwork((s) => s.active !== null);

  return (
    <>
      <footer className="flex h-[72px] shrink-0 items-center gap-4 px-2">
        <NowPlayingInfo />
        <Transport />
        <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
          <IconButton
            label={t("player.nowPlayingPanel")}
            active={rightPanel === "nowPlaying"}
            onClick={() => toggleRightPanel("nowPlaying")}
          >
            <PanelRight size={18} />
          </IconButton>
          <IconButton label={t("player.lyrics")} active={lyricsRoute.open} onClick={lyricsRoute.toggle}>
            <MicVocal size={18} />
          </IconButton>
          <IconButton
            label={t("player.queue")}
            active={rightPanel === "queue"}
            onClick={() => toggleRightPanel("queue")}
          >
            <ListMusic size={18} />
          </IconButton>
          <IconButton
            label={t("player.devices")}
            active={rightPanel === "audio" || onSpeaker}
            onClick={() => toggleRightPanel("audio")}
          >
            <MonitorSpeaker size={18} />
          </IconButton>
          <VolumeControl />
          <IconButton label={t("player.miniplayer")} onClick={openMini}>
            <PictureInPicture2 size={18} />
          </IconButton>
          <IconButton label={t("player.fullscreen")} onClick={openFullscreen}>
            <Maximize2 size={18} />
          </IconButton>
        </div>
      </footer>
      <SpeakerStrip />
    </>
  );
}
