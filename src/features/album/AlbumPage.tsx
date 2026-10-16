import { Link, useNavigate, useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { DropdownMenu } from "radix-ui";
import { Ellipsis, Heart, ListEnd, ListStart, Mic2, Shuffle } from "lucide-react";
import { describeError } from "@/api/errors";
import { ProviderError, type AlbumDetail } from "@/api/provider";
import { useAlbum, useArtist, useSetStarred } from "@/api/queries";
import { Cover } from "@/components/media/Cover";
import { MediaCard } from "@/components/media/MediaCard";
import { PageHeader } from "@/components/media/PageHeader";
import { Shelf } from "@/components/media/Shelf";
import { TrackList } from "@/components/media/TrackList";
import { menuContent, menuItem } from "@/components/media/TrackMenu";
import { IconButton } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { toast, toastError } from "@/components/ui/toast";
import { formatLongDuration } from "@/lib/format";
import { playOrToggle, useIsContextPlaying } from "@/player/actions";
import { isLossless, qualityLabel } from "@/player/quality";
import { usePlayer } from "@/player/store";

/** Quality chip text when every track shares one lossless format. */
function sharedLosslessLabel(album: AlbumDetail): string | null {
  if (album.tracks.length === 0) return null;
  const labels = new Set(album.tracks.map((tr) => (isLossless(tr.format) ? qualityLabel(tr.format) : null)));
  if (labels.size !== 1) return null;
  return [...labels][0] ?? null;
}

export function AlbumPage() {
  const { id } = useParams();
  const { t } = useTranslation();
  const query = useAlbum(id);

  if (query.isPending) {
    return (
      <div className="grid place-items-center p-16 text-subdued">
        <Spinner />
      </div>
    );
  }
  if (query.isError) {
    const missing = query.error instanceof ProviderError && query.error.kind === "notFound";
    return (
      <p className="p-6 text-subdued">{missing ? t("album.notFound") : describeError(t, query.error)}</p>
    );
  }
  return <AlbumView album={query.data} />;
}

function AlbumView({ album }: { album: AlbumDetail }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const setStarred = useSetStarred();
  const playing = useIsContextPlaying("album", album.id);
  const primaryArtist = album.artists[0];
  const artist = useArtist(primaryArtist?.id);
  const context = { type: "album" as const, id: album.id, name: album.name };

  const kind = (() => {
    switch (album.releaseType) {
      case "single":
        return t("album.kindSingle");
      case "ep":
        return t("album.kindEp");
      case "compilation":
        return t("album.kindCompilation");
      case "live":
        return t("album.kindLive");
      default:
        return t("album.kindAlbum");
    }
  })();
  const quality = sharedLosslessLabel(album);
  const otherAlbums = (artist.data?.albums ?? []).filter((a) => a.id !== album.id);

  function play() {
    playOrToggle(context, () => album.tracks);
  }

  function shuffle() {
    usePlayer.getState().setShuffle("shuffle");
    usePlayer.getState().playTracks(album.tracks, 0, context);
  }

  function toggleSaved() {
    const starred = !album.starred;
    setStarred.mutate(
      { kind: "album", id: album.id, starred },
      {
        onSuccess: () => toast(starred ? t("album.saved") : t("album.unsaved")),
        onError: (error) => toastError(describeError(t, error)),
      },
    );
  }

  const meta = (
    <>
      {album.artists.map((a, i) => (
        <span key={`${a.id ?? a.name}-${i}`} className="inline-flex items-center gap-1.5 font-bold">
          {i === 0 && (
            <Cover cover={artist.data?.cover} size={24} round fallback="artist" className="w-6 shadow-none" />
          )}
          {a.id ? (
            <Link to={`/artist/${a.id}`} className="hover:underline">
              {a.name}
            </Link>
          ) : (
            a.name
          )}
          {i < album.artists.length - 1 && <span className="font-normal">,&nbsp;</span>}
        </span>
      ))}
      {album.year != null && <span>&nbsp;• {album.year}</span>}
      <span>&nbsp;• {t("album.tracks", { count: album.tracks.length })}</span>
      <span>&nbsp;• {formatLongDuration(album.durationMs)}</span>
      {quality && (
        <span className="ml-2 rounded-sm bg-accent-soft px-1.5 py-0.5 text-xs font-bold text-accent">
          {quality}
        </span>
      )}
    </>
  );

  const actions = (
    <div className="flex items-center gap-4">
      <IconButton label={t("album.shuffle")} size={40} onClick={shuffle}>
        <Shuffle size={24} />
      </IconButton>
      <IconButton
        label={album.starred ? t("album.unsave") : t("album.save")}
        size={40}
        active={album.starred}
        onClick={toggleSaved}
      >
        <Heart size={28} className={album.starred ? "fill-current" : undefined} />
      </IconButton>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <IconButton label={t("album.more")} size={40}>
            <Ellipsis size={28} />
          </IconButton>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" sideOffset={6} className={menuContent}>
            <DropdownMenu.Item
              className={menuItem}
              onSelect={() => {
                usePlayer.getState().addToQueue(album.tracks);
                toast(t("album.addedToQueue"));
              }}
            >
              <ListEnd size={18} />
              {t("album.addToQueue")}
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className={menuItem}
              onSelect={() => {
                usePlayer.getState().playNext(album.tracks);
                toast(t("album.playingNext"));
              }}
            >
              <ListStart size={18} />
              {t("album.playNext")}
            </DropdownMenu.Item>
            {primaryArtist?.id && (
              <DropdownMenu.Item
                className={menuItem}
                onSelect={() => navigate(`/artist/${primaryArtist.id}`)}
              >
                <Mic2 size={18} />
                {t("album.goToArtist")}
              </DropdownMenu.Item>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );

  return (
    <div className="flex flex-col pb-10">
      <PageHeader
        kind={kind}
        title={album.name}
        cover={album.cover}
        coverFallback="album"
        meta={meta}
        playing={playing}
        onPlay={play}
        actions={actions}
      />
      <div className="px-6">
        {album.tracks.length === 0 ? (
          <p className="py-6 text-subdued">{t("album.empty")}</p>
        ) : (
          <TrackList
            tracks={album.tracks}
            showCover={false}
            showAlbum={false}
            showDiscs
            discTitles={album.discTitles}
            useTrackNumbers
            onPlay={(index) => usePlayer.getState().playTracks(album.tracks, index, context)}
          />
        )}
        {album.year != null && (
          <p className="mt-6 text-sm text-subdued">{t("album.released", { date: String(album.year) })}</p>
        )}
      </div>
      {otherAlbums.length > 0 && primaryArtist && (
        <div className="mt-8 px-3">
          <Shelf
            title={t("album.moreFrom", { artist: primaryArtist.name })}
            moreTo={primaryArtist.id ? `/artist/${primaryArtist.id}` : undefined}
            items={otherAlbums}
            getKey={(a) => a.id}
            renderItem={(a) => (
              <MediaCard title={a.name} subtitle={a.year} cover={a.cover} to={`/album/${a.id}`} />
            )}
          />
        </div>
      )}
    </div>
  );
}
