import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import type { Lyrics } from "@/api/provider";
import { useCoverColor } from "@/components/media/useCoverColor";
import type { Rgb } from "@/lib/color";
import { usePlayer } from "@/player/store";
import { LYRICS_PATH } from "./useLyricsRoute";
import { previewLines, useLyricsOffset } from "./timing";
import { useLyrics } from "./useLyrics";
import { useLyricsClock } from "./useLyricsClock";

const darken = (rgb: Rgb, factor: number) =>
  `rgb(${Math.round(rgb.r * factor)} ${Math.round(rgb.g * factor)} ${Math.round(rgb.b * factor)})`;

function PreviewBody({ lyrics, trackId }: { lyrics: Lyrics; trackId: string }) {
  const clockMs = useLyricsClock({ intervalMs: 250 });
  const { offsetMs } = useLyricsOffset(trackId);
  const lines = previewLines(lyrics, clockMs - lyrics.offsetMs - offsetMs);
  return (
    <div className="flex flex-col gap-1 text-lg leading-snug font-bold">
      {lines.map(({ line, active }, i) => (
        <p
          key={`${i}-${line.text}`}
          className={active || !lyrics.synced ? "text-text wrap-anywhere" : "text-text/60 wrap-anywhere"}
        >
          {line.text}
        </p>
      ))}
    </div>
  );
}

/** Right-panel teaser: a few lyric lines on the cover's color; opens the full view. Hidden without lyrics. */
export function LyricsPreviewCard() {
  const { t } = useTranslation();
  const track = usePlayer((s) => s.current?.track);
  const { lyrics } = useLyrics(track);
  const rgb = useCoverColor(track?.cover);
  if (!track || !lyrics) return null;

  return (
    <section
      className="overflow-hidden rounded-lg"
      style={{
        backgroundImage: `linear-gradient(160deg, ${darken(rgb, 0.8)} 0%, ${darken(rgb, 0.45)} 100%)`,
      }}
    >
      <Link
        to={LYRICS_PATH}
        aria-label={t("lyrics.openFull")}
        className="flex flex-col gap-3 p-4 hover:bg-white/5"
      >
        <h3 className="font-bold">{t("lyrics.previewTitle")}</h3>
        <PreviewBody lyrics={lyrics} trackId={track.id} />
      </Link>
    </section>
  );
}
