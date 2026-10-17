import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import {
  Heart,
  ListMusic,
  Maximize2,
  MicVocal,
  MonitorSpeaker,
  Pause,
  PictureInPicture2,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useSetStarred } from "@/api/queries";
import { useLyricsRoute } from "@/features/lyrics/useLyricsRoute";
import { Cover } from "@/components/media/Cover";
import { IconButton } from "@/components/ui/Button";
import { Slider } from "@/components/ui/Slider";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/format";
import { isLossless, qualityLabel } from "@/player/quality";
import { usePlayer } from "@/player/store";
import { cycleShuffle } from "@/player/actions";
import { useSession } from "@/api/session";
import { useLayout } from "./layoutStore";

function NowPlayingInfo() {
  const { t } = useTranslation();
  const track = usePlayer((s) => s.current?.track);
  const setStarred = useSetStarred();
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
          <p
            className={cn(
              "text-[11px] font-semibold",
              isLossless(track.format) ? "text-accent" : "text-subdued",
            )}
          >
            {quality}
          </p>
        )}
      </div>
      <IconButton
        label={track.starred ? t("menu.removeFromLiked") : t("menu.addToLiked")}
        active={track.starred}
        onClick={() => setStarred.mutate({ kind: "track", id: track.id, starred: !track.starred })}
        className="ml-1"
      >
        <Heart size={16} className={track.starred ? "fill-current" : ""} />
      </IconButton>
    </div>
  );
}

function Transport() {
  const { t } = useTranslation();
  const { current, isPlaying, positionMs, durationMs, shuffle, repeat } = usePlayer();
  const { togglePlay, next, previous, seek, cycleRepeat } = usePlayer.getState();
  const provider = useSession((s) => s.provider);
  const disabled = !current;
  const fraction = durationMs > 0 ? positionMs / durationMs : 0;
  const shuffleLabel =
    shuffle === "off"
      ? t("player.shuffleOn")
      : shuffle === "shuffle"
        ? t("player.shuffleSmart")
        : t("player.shuffleOff");

  return (
    <div className="flex w-[40%] max-w-[722px] flex-col items-center gap-1">
      <div className="flex items-center gap-4">
        <IconButton
          label={shuffleLabel}
          active={shuffle !== "off"}
          disabled={disabled}
          onClick={() => void cycleShuffle(provider)}
          className="relative"
        >
          <Shuffle size={18} />
          {shuffle === "smart" && (
            <span className="absolute -top-0.5 -right-1 text-[11px] leading-none font-extrabold text-accent">
              +
            </span>
          )}
        </IconButton>
        <IconButton label={t("player.previous")} disabled={disabled} onClick={previous}>
          <SkipBack size={18} fill="currentColor" />
        </IconButton>
        <button
          type="button"
          aria-label={isPlaying ? t("player.pause") : t("player.play")}
          disabled={disabled}
          onClick={togglePlay}
          className="grid size-8 place-items-center rounded-full bg-text text-black transition-transform hover:scale-105 disabled:opacity-50"
        >
          {isPlaying ? (
            <Pause size={16} fill="currentColor" strokeWidth={0} />
          ) : (
            <Play size={16} fill="currentColor" strokeWidth={0} className="translate-x-px" />
          )}
        </button>
        <IconButton label={t("player.next")} disabled={disabled} onClick={next}>
          <SkipForward size={18} fill="currentColor" />
        </IconButton>
        <IconButton
          label={t(`player.repeat.${repeat}`)}
          active={repeat !== "off"}
          disabled={disabled}
          onClick={cycleRepeat}
        >
          {repeat === "one" ? <Repeat1 size={18} /> : <Repeat size={18} />}
        </IconButton>
      </div>
      <div className="flex w-full items-center gap-2 text-xs text-subdued tabular-nums">
        <span className="w-10 text-right">{formatDuration(positionMs)}</span>
        <Slider
          value={fraction}
          onChange={() => {}}
          onCommit={(v) => seek(v * durationMs)}
          label={t("player.progress")}
          valueText={`${formatDuration(positionMs)} / ${formatDuration(durationMs)}`}
          className="flex-1"
        />
        <span className="w-10">{formatDuration(durationMs)}</span>
      </div>
    </div>
  );
}

function VolumeControl() {
  const { t } = useTranslation();
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  const { setVolume, toggleMute } = usePlayer.getState();
  const effective = muted ? 0 : volume;
  const Icon = effective === 0 ? VolumeX : effective < 0.33 ? Volume : effective < 0.66 ? Volume1 : Volume2;

  return (
    <div className="flex items-center gap-1">
      <IconButton label={muted ? t("player.unmute") : t("player.mute")} onClick={toggleMute}>
        <Icon size={18} />
      </IconButton>
      <Slider
        value={effective}
        onChange={setVolume}
        label={t("player.volume")}
        valueText={`${Math.round(effective * 100)} %`}
        className="w-24"
      />
    </div>
  );
}

/** Bottom player bar: now playing, transport with progress, and panel/volume controls. */
export function PlayerBar() {
  const { t } = useTranslation();
  const rightPanel = useLayout((s) => s.rightPanel);
  const toggleRightPanel = useLayout((s) => s.toggleRightPanel);
  const lyricsRoute = useLyricsRoute();

  return (
    <footer className="flex h-[72px] shrink-0 items-center gap-4 px-2">
      <NowPlayingInfo />
      <Transport />
      <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
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
          active={rightPanel === "devices"}
          onClick={() => toggleRightPanel("devices")}
        >
          <MonitorSpeaker size={18} />
        </IconButton>
        <VolumeControl />
        <IconButton label={t("player.miniplayer")}>
          <PictureInPicture2 size={18} />
        </IconButton>
        <IconButton label={t("player.fullscreen")}>
          <Maximize2 size={18} />
        </IconButton>
      </div>
    </footer>
  );
}
