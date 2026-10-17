import { Link } from "react-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Album, AlbumListType, Playlist } from "@/api/provider";
import { describeError } from "@/api/errors";
import { useAlbumList, usePlaylists } from "@/api/queries";
import { useProvider } from "@/api/session";
import { MediaCard } from "@/components/media/MediaCard";
import { Shelf } from "@/components/media/Shelf";
import { Spinner } from "@/components/ui/Spinner";
import { AutoPlaylistShelf } from "@/features/autoplaylists/AutoPlaylistShelf";
import { RecapBanner } from "@/features/recap/RecapBanner";
import { loaders, playOrToggle, useIsContextPlaying } from "@/player/actions";
import { greetingForHour } from "./greeting";
import { QuickTile } from "./QuickTile";
import { normalizeHomeSections } from "@/settings/homeLayout";
import { useSettings } from "@/settings/store";

const QUICK_LIMIT = 8;

function albumSubtitle(album: Album): string {
  return [album.year, album.artistLine].filter(Boolean).join(" • ");
}

function AlbumCard({ album }: { album: Album }) {
  const provider = useProvider();
  const playing = useIsContextPlaying("album", album.id);
  return (
    <MediaCard
      title={album.name}
      subtitle={albumSubtitle(album)}
      cover={album.cover}
      to={`/album/${album.id}`}
      playing={playing}
      onPlay={() =>
        playOrToggle({ type: "album", id: album.id, name: album.name }, loaders.album(provider, album.id))
      }
    />
  );
}

function PlaylistCard({ playlist }: { playlist: Playlist }) {
  const provider = useProvider();
  const playing = useIsContextPlaying("playlist", playlist.id);
  return (
    <MediaCard
      title={playlist.name}
      subtitle={playlist.owner}
      cover={playlist.cover}
      fallback="playlist"
      to={`/playlist/${playlist.id}`}
      playing={playing}
      onPlay={() =>
        playOrToggle(
          { type: "playlist", id: playlist.id, name: playlist.name },
          loaders.playlist(provider, playlist.id),
        )
      }
    />
  );
}

type Quick = { kind: "album"; item: Album } | { kind: "playlist"; item: Playlist };

function QuickItem({ entry }: { entry: Quick }) {
  const provider = useProvider();
  const playing = useIsContextPlaying(entry.kind, entry.item.id);
  if (entry.kind === "album") {
    const a = entry.item;
    return (
      <QuickTile
        title={a.name}
        cover={a.cover}
        fallback="album"
        to={`/album/${a.id}`}
        playing={playing}
        onPlay={() => playOrToggle({ type: "album", id: a.id, name: a.name }, loaders.album(provider, a.id))}
      />
    );
  }
  const p = entry.item;
  return (
    <QuickTile
      title={p.name}
      cover={p.cover}
      fallback="playlist"
      to={`/playlist/${p.id}`}
      playing={playing}
      onPlay={() =>
        playOrToggle({ type: "playlist", id: p.id, name: p.name }, loaders.playlist(provider, p.id))
      }
    />
  );
}

/** Alternates recently played albums and playlists, without duplicates, up to the limit. */
function buildQuickAccess(albums: Album[], playlists: Playlist[]): Quick[] {
  const result: Quick[] = [];
  const max = Math.max(albums.length, playlists.length);
  for (let i = 0; i < max && result.length < QUICK_LIMIT; i++) {
    const album = albums[i];
    const playlist = playlists[i];
    if (album) result.push({ kind: "album", item: album });
    if (playlist && result.length < QUICK_LIMIT) result.push({ kind: "playlist", item: playlist });
  }
  return result;
}

const ALBUM_SHELVES: (AlbumListType &
  ("recentlyPlayed" | "recentlyAdded" | "mostPlayed" | "random" | "starred"))[] = [
  "recentlyPlayed",
  "recentlyAdded",
  "mostPlayed",
  "random",
  "starred",
];

export function HomePage() {
  const { t } = useTranslation();
  const recentlyPlayed = useAlbumList("recentlyPlayed");
  const recentlyAdded = useAlbumList("recentlyAdded");
  const mostPlayed = useAlbumList("mostPlayed");
  const random = useAlbumList("random");
  const starred = useAlbumList("starred");
  const playlists = usePlaylists();
  const lists = { recentlyPlayed, recentlyAdded, mostPlayed, random, starred };
  const savedSections = useSettings((s) => s.homeSections);
  const sections = useMemo(() => normalizeHomeSections(savedSections), [savedSections]);

  const all = [...Object.values(lists), playlists];
  const loading = all.some((q) => q.isPending);
  const allFailed = all.every((q) => q.isError);
  const firstError = all.find((q) => q.isError)?.error;

  const quick = useMemo(
    () => buildQuickAccess(recentlyPlayed.data ?? [], playlists.data ?? []),
    [recentlyPlayed.data, playlists.data],
  );
  const hasContent = ALBUM_SHELVES.some((k) => (lists[k].data?.length ?? 0) > 0) || !!playlists.data?.length;
  const greeting = t(`home.greeting.${greetingForHour(new Date().getHours())}`);

  return (
    <div className="min-h-full bg-gradient-to-b from-accent-soft to-transparent to-[320px] px-6 pt-16 pb-10">
      <h1 className="text-3xl font-extrabold tracking-tight">{greeting}</h1>

      {loading && !hasContent ? (
        <div className="grid place-items-center py-24 text-subdued">
          <Spinner size={32} />
        </div>
      ) : allFailed ? (
        <p className="py-16 text-subdued">{describeError(t, firstError)}</p>
      ) : !hasContent ? (
        <div className="flex flex-col items-center gap-1 py-24 text-center">
          <p className="text-xl font-bold">{t("home.emptyTitle")}</p>
          <p className="max-w-md text-subdued">{t("home.emptyText")}</p>
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-8">
          <RecapBanner />
          {quick.length > 0 && (
            <section aria-label={t("home.quickAccess")} className="grid grid-cols-2 gap-3 2xl:grid-cols-4">
              {quick.map((entry) => (
                <QuickItem key={`${entry.kind}-${entry.item.id}`} entry={entry} />
              ))}
            </section>
          )}
          {sections
            .filter((section) => section.visible)
            .map(({ id }) =>
              id === "autoPlaylists" ? (
                <AutoPlaylistShelf key={id} />
              ) : id === "playlists" ? (
                <Shelf
                  key={id}
                  title={t("home.playlists")}
                  items={playlists.data ?? []}
                  getKey={(p) => p.id}
                  renderItem={(p) => <PlaylistCard playlist={p} />}
                />
              ) : (
                <Shelf
                  key={id}
                  title={t(`home.${id}`)}
                  moreTo={`/albums/${id}`}
                  items={lists[id].data ?? []}
                  getKey={(a) => a.id}
                  renderItem={(a) => <AlbumCard album={a} />}
                />
              ),
            )}
          <Link
            to="/settings#settings-home"
            className="self-start text-sm font-bold text-subdued hover:text-text hover:underline"
          >
            {t("home.customize")}
          </Link>
        </div>
      )}
    </div>
  );
}
