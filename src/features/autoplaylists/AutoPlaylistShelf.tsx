import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useAlbumList } from "@/api/queries";
import { useProvider } from "@/api/session";
import { MediaCard } from "@/components/media/MediaCard";
import { Shelf } from "@/components/media/Shelf";
import { playOrToggle, useIsContextPlaying } from "@/player/actions";
import { AutoCover } from "./AutoCover";
import { autoContextId, autoSlug, type AutoRef } from "./autoPlaylists";
import { autoPlaylistQuery, useAutoAvailable } from "./queries";
import { useAutoTitle } from "./useAutoTitle";

function AutoCard({ auto }: { auto: AutoRef }) {
  const { t } = useTranslation();
  const provider = useProvider();
  const client = useQueryClient();
  const title = useAutoTitle(auto);
  const contextId = autoContextId(auto);
  const playing = useIsContextPlaying("mix", contextId);
  return (
    <MediaCard
      title={title}
      subtitle={t(`autoPlaylists.short.${auto.kind}`)}
      art={<AutoCover auto={auto} />}
      to={`/auto/${autoSlug(auto)}`}
      playing={playing}
      onPlay={() =>
        playOrToggle({ type: "mix", id: contextId, name: title }, async () => {
          const { tracks } = await client.fetchQuery(autoPlaylistQuery(provider, auto));
          return tracks;
        })
      }
    />
  );
}

/** The automatic playlists that have enough listening history behind them. */
function useAvailableAutoPlaylists(): AutoRef[] {
  const year = new Date().getFullYear();
  const heavy = useAutoAvailable({ kind: "heavyRotation" });
  const rediscovered = useAutoAvailable({ kind: "rediscovered" });
  const allTimeLocal = useAutoAvailable({ kind: "allTime" });
  const topThis = useAutoAvailable({ kind: "topYear", year });
  const topLast = useAutoAvailable({ kind: "topYear", year: year - 1 });
  // Servers that count plays themselves can fill the all-time list without any local history.
  const serverPlayed = useAlbumList("mostPlayed");
  const serverHasPlays = (serverPlayed.data?.length ?? 0) > 0;

  return useMemo(() => {
    const list: AutoRef[] = [];
    if (heavy.data) list.push({ kind: "heavyRotation" });
    if (rediscovered.data) list.push({ kind: "rediscovered" });
    if (allTimeLocal.data || serverHasPlays) list.push({ kind: "allTime" });
    if (topThis.data) list.push({ kind: "topYear", year });
    if (topLast.data) list.push({ kind: "topYear", year: year - 1 });
    return list;
  }, [heavy.data, rediscovered.data, allTimeLocal.data, serverHasPlays, topThis.data, topLast.data, year]);
}

/** Home page row with the automatic playlists. Renders nothing while there is no history. */
export function AutoPlaylistShelf() {
  const { t } = useTranslation();
  const items = useAvailableAutoPlaylists();
  return (
    <Shelf
      title={t("autoPlaylists.shelfTitle")}
      items={items}
      getKey={autoSlug}
      renderItem={(auto) => <AutoCard auto={auto} />}
    />
  );
}
