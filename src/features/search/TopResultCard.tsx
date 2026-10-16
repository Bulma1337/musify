import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import type { SearchResult } from "@/api/provider";
import { useProvider } from "@/api/session";
import { Cover } from "@/components/media/Cover";
import { PlayButton } from "@/components/media/PlayButton";
import { cn } from "@/lib/cn";
import { loaders, playOrToggle, useIsContextPlaying } from "@/player/actions";
import { usePlayer } from "@/player/store";
import type { TopResult } from "./topResult";

/** Large "Top-Ergebnis" card: cover, name, type chip and a play button on hover. */
export function TopResultCard({
  top,
  results,
  query,
}: {
  top: TopResult;
  results: SearchResult;
  query: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const provider = useProvider();
  const contextId = top.type === "track" ? undefined : top.item.id;
  const playing = useIsContextPlaying(top.type === "track" ? "search" : top.type, contextId);

  const name = top.type === "track" ? top.item.title : top.item.name;
  const chip = t(
    top.type === "artist"
      ? "search.typeArtist"
      : top.type === "album"
        ? "search.typeAlbum"
        : "search.typeTrack",
  );
  const subtitle =
    top.type === "track" ? top.item.artistLine : top.type === "album" ? top.item.artistLine : undefined;
  const to =
    top.type === "artist"
      ? `/artist/${top.item.id}`
      : top.type === "album"
        ? `/album/${top.item.id}`
        : top.item.album
          ? `/album/${top.item.album.id}`
          : undefined;

  function play() {
    if (top.type === "artist") {
      playOrToggle(
        { type: "artist", id: top.item.id, name: top.item.name },
        loaders.artist(provider, top.item.id, top.item.name),
      );
    } else if (top.type === "album") {
      playOrToggle(
        { type: "album", id: top.item.id, name: top.item.name },
        loaders.album(provider, top.item.id),
      );
    } else {
      const index = results.tracks.indexOf(top.item);
      usePlayer.getState().playTracks(results.tracks, Math.max(0, index), {
        type: "search",
        name: t("search.context", { query }),
      });
    }
  }

  return (
    <div
      role={to ? "link" : undefined}
      tabIndex={to ? 0 : undefined}
      onClick={() => to && navigate(to)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && to) navigate(to);
      }}
      className={cn(
        "group relative flex flex-col gap-5 rounded-lg bg-elevated p-5 transition-colors hover:bg-highlight focus-visible:bg-highlight",
        to && "cursor-pointer",
      )}
    >
      <Cover
        cover={top.item.cover}
        size={92}
        round={top.type === "artist"}
        fallback={top.type === "artist" ? "artist" : top.type === "album" ? "album" : "track"}
        className="w-[92px]"
      />
      <div className="min-w-0">
        <p className="truncate text-3xl font-bold tracking-tight" title={name}>
          {name}
        </p>
        <p className="mt-2 flex min-w-0 items-center gap-2 text-sm">
          {subtitle && <span className="truncate text-subdued">{subtitle}</span>}
          <span className="shrink-0 rounded-full bg-surface px-3 py-1 font-bold">{chip}</span>
        </p>
      </div>
      <PlayButton
        playing={playing}
        onClick={play}
        size={48}
        className={cn(
          "absolute right-5 bottom-5 transition-[opacity,translate] duration-200",
          playing
            ? "translate-y-0 opacity-100"
            : "translate-y-2 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100",
        )}
      />
    </div>
  );
}
