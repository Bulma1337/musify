import type { TFunction } from "i18next";
import { formatNumber } from "@/lib/format";
import type { RecapData } from "./model";
import type { ShareContent } from "./shareImage";

/** The translated texts drawn on the share images. */
export function buildShareContent(data: RecapData, t: TFunction): ShareContent {
  const top = data.topSongs[0];
  return {
    year: data.year,
    title: t("recap.title", { year: data.year }),
    minutes: formatNumber(data.minutes),
    minutesLabel: t("recap.share.minutesLabel"),
    topSongLabel: t("recap.share.topSong"),
    topSong: top ? { title: top.title, artist: top.artist ?? "" } : undefined,
    topArtistsLabel: t("recap.share.topArtists"),
    topArtists: data.topArtists.map((row) => row.title),
    topSongsLabel: t("recap.share.topSongs"),
    topSongs: data.topSongs.map((row) => row.title),
    topGenre: data.genres[0]?.row.title,
    topGenreLabel: t("recap.share.topGenre"),
    personality: t(`recap.personality.${data.personality.id}.name`),
    personalityLabel: t("recap.share.personality"),
    footer: t("recap.share.footer"),
  };
}

/** File name for a saved image, e.g. "navify-rueckblick-2025-story.png". */
export function shareFileName(year: number, format: "story" | "square"): string {
  return `navify-recap-${year}-${format}.png`;
}
