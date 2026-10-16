import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { useSearch } from "@/api/queries";
import { describeError } from "@/api/errors";
import { CardGrid, Shelf } from "@/components/media/Shelf";
import { TrackList } from "@/components/media/TrackList";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/cn";
import { usePlayer } from "@/player/store";
import { AlbumResultCard, ArtistResultCard } from "./cards";
import { CompactTrackRow } from "./CompactTrackRow";
import { GenreGrid } from "./GenreGrid";
import { TopResultCard } from "./TopResultCard";
import { pickTopResult } from "./topResult";

type Filter = "all" | "tracks" | "albums" | "artists";
const FILTERS: Filter[] = ["all", "tracks", "albums", "artists"];

function Results({ query }: { query: string }) {
  const { t } = useTranslation();
  const search = useSearch(query);
  const [chosen, setFilter] = useState<Filter>("all");
  const data = search.data;
  const top = useMemo(() => (data ? pickTopResult(data, query) : null), [data, query]);
  const context = { type: "search" as const, name: t("search.context", { query }) };

  if (!data) {
    return search.isError ? (
      <p className="p-6 text-subdued">{describeError(t, search.error)}</p>
    ) : (
      <div className="grid h-64 place-items-center text-subdued">
        <Spinner />
      </div>
    );
  }

  const empty = data.tracks.length + data.albums.length + data.artists.length === 0;
  if (empty) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-24 text-center">
        <h1 className="text-2xl font-bold tracking-tight">{t("search.noResultsTitle", { query })}</h1>
        <p className="text-subdued">{t("search.noResultsHint")}</p>
      </div>
    );
  }

  const counts: Record<Filter, number> = {
    all: 1,
    tracks: data.tracks.length,
    albums: data.albums.length,
    artists: data.artists.length,
  };

  const filter = counts[chosen] > 0 ? chosen : "all";

  return (
    <div className="flex flex-col gap-6 py-4 pb-8">
      <div role="group" aria-label={t("search.filters")} className="flex flex-wrap gap-2 px-6">
        {FILTERS.filter((f) => counts[f] > 0).map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className={cn(
              "h-8 rounded-full px-4 text-sm font-semibold transition-colors",
              filter === f ? "bg-text text-black" : "bg-white/10 text-text hover:bg-white/20",
            )}
          >
            {t(`search.${f}`)}
          </button>
        ))}
      </div>

      {filter === "all" && (
        <>
          <div className="grid gap-6 px-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            {top && (
              <section className="flex flex-col gap-3">
                <h2 className="text-2xl font-bold tracking-tight">{t("search.topResult")}</h2>
                <TopResultCard top={top} results={data} query={query} />
              </section>
            )}
            {data.tracks.length > 0 && (
              <section className="flex min-w-0 flex-col gap-3">
                <h2 className="text-2xl font-bold tracking-tight">{t("search.tracks")}</h2>
                <div>
                  {data.tracks.slice(0, 4).map((track, index) => (
                    <CompactTrackRow
                      key={track.id}
                      track={track}
                      onPlay={() => usePlayer.getState().playTracks(data.tracks, index, context)}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
          <Shelf
            title={t("search.artists")}
            items={data.artists}
            getKey={(a) => a.id}
            renderItem={(a) => <ArtistResultCard artist={a} />}
          />
          <Shelf
            title={t("search.albums")}
            items={data.albums}
            getKey={(a) => a.id}
            renderItem={(a) => <AlbumResultCard album={a} />}
          />
        </>
      )}

      {filter === "tracks" && (
        <div className="px-6">
          <TrackList
            tracks={data.tracks}
            onPlay={(index) => usePlayer.getState().playTracks(data.tracks, index, context)}
          />
        </div>
      )}
      {filter === "albums" && (
        <div className="px-3">
          <CardGrid
            items={data.albums}
            getKey={(a) => a.id}
            renderItem={(a) => <AlbumResultCard album={a} />}
          />
        </div>
      )}
      {filter === "artists" && (
        <div className="px-3">
          <CardGrid
            items={data.artists}
            getKey={(a) => a.id}
            renderItem={(a) => <ArtistResultCard artist={a} />}
          />
        </div>
      )}
    </div>
  );
}

/** Search results for `?q=`, or the genre browse grid while the query is empty. */
export function SearchPage() {
  const [params] = useSearchParams();
  const query = (params.get("q") ?? "").trim();
  return query ? <Results key="results" query={query} /> : <GenreGrid />;
}
