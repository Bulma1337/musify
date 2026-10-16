import { useEffect, useRef } from "react";
import { useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { Album, AlbumListType } from "@/api/provider";
import { describeError } from "@/api/errors";
import { useProvider } from "@/api/session";
import { useScrollContainer } from "@/app/layout/scrollContainer";
import { MediaCard } from "@/components/media/MediaCard";
import { CardGrid } from "@/components/media/Shelf";
import { Spinner } from "@/components/ui/Spinner";
import { loaders, playOrToggle, useIsContextPlaying } from "@/player/actions";

const PAGE_SIZE = 60;

const TYPES: AlbumListType[] = [
  "recentlyPlayed",
  "recentlyAdded",
  "mostPlayed",
  "random",
  "starred",
  "alphabeticalByName",
  "alphabeticalByArtist",
  "highestRated",
  "byYear",
  "byGenre",
];

function isAlbumListType(value: string | undefined): value is AlbumListType {
  return TYPES.includes(value as AlbumListType);
}

function AlbumCard({ album }: { album: Album }) {
  const provider = useProvider();
  const playing = useIsContextPlaying("album", album.id);
  return (
    <MediaCard
      title={album.name}
      subtitle={[album.year, album.artistLine].filter(Boolean).join(" • ")}
      cover={album.cover}
      to={`/album/${album.id}`}
      playing={playing}
      onPlay={() =>
        playOrToggle({ type: "album", id: album.id, name: album.name }, loaders.album(provider, album.id))
      }
    />
  );
}

export function AlbumGridPage() {
  const { t } = useTranslation();
  const { type } = useParams();
  if (!isAlbumListType(type)) {
    return <p className="px-6 pt-16 text-subdued">{t("browse.unknownType")}</p>;
  }
  return <AlbumGrid type={type} />;
}

function AlbumGrid({ type }: { type: AlbumListType }) {
  const { t } = useTranslation();
  const provider = useProvider();
  const scrollElement = useScrollContainer();
  const sentinel = useRef<HTMLDivElement>(null);

  const query = useInfiniteQuery({
    queryKey: [provider.server.id, "albumGrid", type],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => provider.getAlbumList(type, { size: PAGE_SIZE, offset: pageParam }),
    getNextPageParam: (last, pages) =>
      last.length < PAGE_SIZE ? undefined : pages.reduce((sum, p) => sum + p.length, 0),
    staleTime: type === "random" ? 0 : undefined,
  });

  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = query;
  const pageCount = query.data?.pages.length ?? 0;

  useEffect(() => {
    const element = sentinel.current;
    if (!element || !hasNextPage || isError) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && !isFetchingNextPage) void fetchNextPage();
      },
      { root: scrollElement, rootMargin: "0px 0px 600px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
    // pageCount re-arms the observer so a sentinel that stays visible loads the next page too.
  }, [scrollElement, hasNextPage, isFetchingNextPage, isError, fetchNextPage, pageCount]);

  const albums = query.data?.pages.flat() ?? [];

  return (
    <div className="min-h-full bg-gradient-to-b from-accent-soft to-transparent to-[240px] px-6 pt-16 pb-10">
      <h1 className="mb-4 px-3 text-3xl font-extrabold tracking-tight">{t(`browse.${type}`)}</h1>
      {query.isPending ? (
        <div className="grid place-items-center py-24 text-subdued">
          <Spinner size={32} />
        </div>
      ) : query.isError && albums.length === 0 ? (
        <p className="py-8 text-subdued">{describeError(t, query.error)}</p>
      ) : albums.length === 0 ? (
        <p className="py-8 text-subdued">{t("browse.empty")}</p>
      ) : (
        <>
          <CardGrid items={albums} getKey={(a) => a.id} renderItem={(a) => <AlbumCard album={a} />} />
          {query.isError && <p className="py-4 text-subdued">{describeError(t, query.error)}</p>}
          <div ref={sentinel} className="flex h-16 items-center justify-center text-subdued">
            {isFetchingNextPage && <Spinner size={24} />}
          </div>
        </>
      )}
    </div>
  );
}
