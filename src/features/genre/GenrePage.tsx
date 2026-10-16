import { useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import type { Album, Track } from "@/api/provider";
import { describeError } from "@/api/errors";
import { useAlbumList } from "@/api/queries";
import { useProvider } from "@/api/session";
import { MediaCard } from "@/components/media/MediaCard";
import { PlayButton } from "@/components/media/PlayButton";
import { CardGrid } from "@/components/media/Shelf";
import { TrackList } from "@/components/media/TrackList";
import { Spinner } from "@/components/ui/Spinner";
import { loaders, playOrToggle, useIsContextPlaying } from "@/player/actions";
import { usePlayer } from "@/player/store";
import { genreColor } from "./genreColor";

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

function Loading() {
  return (
    <div className="grid place-items-center py-12 text-subdued">
      <Spinner />
    </div>
  );
}

export function GenrePage() {
  const { t } = useTranslation();
  const params = useParams();
  let name = params.name ?? "";
  try {
    name = decodeURIComponent(name);
  } catch {
    // keep the raw segment
  }
  const provider = useProvider();
  const playing = useIsContextPlaying("genre", name);
  const albums = useAlbumList("byGenre", 30, { genre: name });
  const tracks = useQuery({
    queryKey: [provider.server.id, "genreTracks", name],
    queryFn: () => provider.getTracksByGenre(name, { size: 100 }),
    enabled: !!name,
  });
  const color = genreColor(name);
  const context = { type: "genre", id: name, name } as const;

  const playAll = () => {
    const list = tracks.data;
    if (!list || list.length === 0) return;
    const player = usePlayer.getState();
    if (player.context?.type === "genre" && player.context.id === name && player.current) {
      player.togglePlay();
      return;
    }
    player.setShuffle("shuffle");
    player.playTracks(list, Math.floor(Math.random() * list.length), context);
  };
  const playFrom = (list: Track[], index: number) => usePlayer.getState().playTracks(list, index, context);

  return (
    <div className="min-h-full">
      <header
        className="flex flex-col gap-2 px-6 pt-24 pb-6"
        style={{ background: `linear-gradient(${color.base}, ${color.dark})` }}
      >
        <span className="text-sm font-semibold">{t("genre.kind")}</span>
        <h1 className="text-[clamp(2.5rem,7vw,6rem)] leading-[1.05] font-extrabold tracking-tight break-words">
          {name}
        </h1>
      </header>

      <div className="flex items-center gap-6 px-6 py-6">
        <PlayButton playing={playing} onClick={playAll} />
        <span className="sr-only">{t("genre.playShuffled")}</span>
      </div>

      <section className="flex flex-col gap-2 pb-6">
        <h2 className="px-9 text-2xl font-bold tracking-tight">{t("genre.albums")}</h2>
        <div className="px-6">
          {albums.isPending ? (
            <Loading />
          ) : albums.isError ? (
            <p className="px-3 text-subdued">{describeError(t, albums.error)}</p>
          ) : (
            <CardGrid items={albums.data} getKey={(a) => a.id} renderItem={(a) => <AlbumCard album={a} />} />
          )}
        </div>
      </section>

      <section className="flex flex-col gap-2 pb-10">
        <h2 className="px-9 text-2xl font-bold tracking-tight">{t("genre.tracks")}</h2>
        <div className="px-6">
          {tracks.isPending ? (
            <Loading />
          ) : tracks.isError ? (
            <p className="px-3 text-subdued">{describeError(t, tracks.error)}</p>
          ) : tracks.data.length === 0 ? (
            <p className="px-3 text-subdued">{t("genre.empty")}</p>
          ) : (
            <TrackList tracks={tracks.data} showCover showAlbum onPlay={(i) => playFrom(tracks.data, i)} />
          )}
        </div>
      </section>
    </div>
  );
}
