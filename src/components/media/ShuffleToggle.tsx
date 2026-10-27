import { useTranslation } from "react-i18next";
import { Shuffle } from "lucide-react";
import type { Track } from "@/api/provider";
import { IconButton } from "@/components/ui/Button";
import { useIsContextActive } from "@/player/actions";
import { usePlayer, type PlayContext } from "@/player/store";

export interface ShuffleToggleProps {
  context: PlayContext;
  /** The page's tracks, for starting it shuffled. */
  tracks: () => Track[];
  /** Label while shuffle is off ("Shuffle album", …). */
  label: string;
}

/**
 * Shuffle button next to a page's play button. Lit while shuffle is on (like the one in the player
 * bar) and toggles it. Turning it on starts the page at a random track unless it is already playing.
 */
export function ShuffleToggle({ context, tracks, label }: ShuffleToggleProps) {
  const { t } = useTranslation();
  const on = usePlayer((s) => s.shuffle !== "off");
  const active = useIsContextActive(context.type, context.id);

  function toggle() {
    const player = usePlayer.getState();
    if (on) {
      player.setShuffle("off");
      return;
    }
    player.setShuffle("shuffle");
    if (active) return;
    const list = tracks();
    if (list.length === 0) return;
    usePlayer.getState().playTracks(list, Math.floor(Math.random() * list.length), context);
  }

  return (
    <IconButton label={on ? t("player.shuffleOff") : label} size={40} active={on} onClick={toggle}>
      <Shuffle size={24} />
    </IconButton>
  );
}
