import { useTranslation } from "react-i18next";
import {
  Heart,
  Pause,
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
import type { Track } from "@/api/provider";
import { useSetStarred } from "@/api/queries";
import { useSession } from "@/api/session";
import { IconButton } from "@/components/ui/Button";
import { Slider } from "@/components/ui/Slider";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/format";
import { cycleShuffle } from "@/player/actions";
import { usePlayer } from "@/player/store";

/** Player controls shared by the player bar, the full-screen player and the miniplayer. */

export function LikeButton({ track, size = 16 }: { track: Track; size?: number }) {
  const { t } = useTranslation();
  const setStarred = useSetStarred();
  return (
    <IconButton
      label={track.starred ? t("menu.removeFromLiked") : t("menu.addToLiked")}
      active={track.starred}
      onClick={() => setStarred.mutate({ kind: "track", id: track.id, starred: !track.starred })}
    >
      <Heart size={size} className={track.starred ? "fill-current" : ""} />
    </IconButton>
  );
}

/** Shuffle, previous, play/pause, next, repeat. `size` scales the icons (player bar: 18). */
export function TransportButtons({
  size = 18,
  compact = false,
  className,
}: {
  size?: number;
  /** Only previous, play/pause and next (miniplayer). */
  compact?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const current = usePlayer((s) => s.current);
  const isPlaying = usePlayer((s) => s.isPlaying);
  const shuffle = usePlayer((s) => s.shuffle);
  const repeat = usePlayer((s) => s.repeat);
  const { togglePlay, next, previous, cycleRepeat } = usePlayer.getState();
  const provider = useSession((s) => s.provider);
  const disabled = !current;
  const shuffleLabel =
    shuffle === "off"
      ? t("player.shuffleOn")
      : shuffle === "shuffle"
        ? t("player.shuffleSmart")
        : t("player.shuffleOff");
  const playSize = Math.round(size * 1.8);

  return (
    <div className={cn("flex items-center gap-4", className)}>
      {!compact && (
        <IconButton
          label={shuffleLabel}
          active={shuffle !== "off"}
          disabled={disabled}
          onClick={() => void cycleShuffle(provider)}
          className="relative"
        >
          <Shuffle size={size} />
          {shuffle === "smart" && (
            <span className="absolute -top-0.5 -right-1 text-[11px] leading-none font-extrabold text-accent">
              +
            </span>
          )}
        </IconButton>
      )}
      <IconButton label={t("player.previous")} disabled={disabled} onClick={previous}>
        <SkipBack size={size} fill="currentColor" />
      </IconButton>
      <button
        type="button"
        aria-label={isPlaying ? t("player.pause") : t("player.play")}
        disabled={disabled}
        onClick={togglePlay}
        style={{ width: playSize, height: playSize }}
        className="grid shrink-0 place-items-center rounded-full bg-text text-black transition-transform hover:scale-105 disabled:opacity-50"
      >
        {isPlaying ? (
          <Pause size={Math.round(size * 0.9)} fill="currentColor" strokeWidth={0} />
        ) : (
          <Play
            size={Math.round(size * 0.9)}
            fill="currentColor"
            strokeWidth={0}
            className="translate-x-px"
          />
        )}
      </button>
      <IconButton label={t("player.next")} disabled={disabled} onClick={next}>
        <SkipForward size={size} fill="currentColor" />
      </IconButton>
      {!compact && (
        <IconButton
          label={t(`player.repeat.${repeat}`)}
          active={repeat !== "off"}
          disabled={disabled}
          onClick={cycleRepeat}
        >
          {repeat === "one" ? <Repeat1 size={size} /> : <Repeat size={size} />}
        </IconButton>
      )}
    </div>
  );
}

/** Elapsed time, seek slider, total time. */
export function ProgressRow({ className, hideTimes = false }: { className?: string; hideTimes?: boolean }) {
  const { t } = useTranslation();
  const positionMs = usePlayer((s) => s.positionMs);
  const durationMs = usePlayer((s) => s.durationMs);
  const seek = usePlayer.getState().seek;
  const fraction = durationMs > 0 ? positionMs / durationMs : 0;
  return (
    <div className={cn("flex w-full items-center gap-2 text-xs text-subdued tabular-nums", className)}>
      {!hideTimes && <span className="w-10 text-right">{formatDuration(positionMs)}</span>}
      <Slider
        value={fraction}
        onChange={() => {}}
        onCommit={(v) => seek(v * durationMs)}
        label={t("player.progress")}
        valueText={`${formatDuration(positionMs)} / ${formatDuration(durationMs)}`}
        className="flex-1"
      />
      {!hideTimes && <span className="w-10">{formatDuration(durationMs)}</span>}
    </div>
  );
}

export function VolumeControl({ sliderClassName = "w-24" }: { sliderClassName?: string }) {
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
        className={sliderClassName}
      />
    </div>
  );
}
