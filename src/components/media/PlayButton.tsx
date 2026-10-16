import { useTranslation } from "react-i18next";
import { Pause, Play } from "lucide-react";
import { cn } from "@/lib/cn";

export interface PlayButtonProps {
  playing: boolean;
  onClick: () => void;
  size?: number;
  className?: string;
}

/** The round accent play/pause button used in headers and on hover over cards. */
export function PlayButton({ playing, onClick, size = 56, className }: PlayButtonProps) {
  const { t } = useTranslation();
  const icon = Math.round(size * 0.42);
  return (
    <button
      type="button"
      aria-label={playing ? t("player.pause") : t("player.play")}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{ width: size, height: size }}
      className={cn(
        "grid shrink-0 place-items-center rounded-full bg-accent text-on-accent shadow-[0_8px_8px_rgb(0_0_0/0.3)] transition-transform hover:scale-105 hover:bg-accent-hover active:scale-95 active:bg-accent-press",
        className,
      )}
    >
      {playing ? (
        <Pause size={icon} fill="currentColor" strokeWidth={0} />
      ) : (
        <Play size={icon} fill="currentColor" strokeWidth={0} className="translate-x-[6%]" />
      )}
    </button>
  );
}
