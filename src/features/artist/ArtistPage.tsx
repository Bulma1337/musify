import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { useTranslation } from "react-i18next";
import type { Album, ArtistDetail, ArtistInfo, Track } from "@/api/provider";
import { ProviderError } from "@/api/provider";
import { describeError } from "@/api/errors";
import { useArtist, useArtistInfo, useSetStarred, useTopTracks } from "@/api/queries";
import { useProvider } from "@/api/session";
import { CardGrid, Shelf } from "@/components/media/Shelf";
import { MediaCard } from "@/components/media/MediaCard";
import { PageHeader } from "@/components/media/PageHeader";
import { PlayButton } from "@/components/media/PlayButton";
import { TrackList } from "@/components/media/TrackList";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { toast, toastError } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { loaders, playOrToggle, useIsContextPlaying } from "@/player/actions";
import { usePlayer } from "@/player/store";
import { stripHtml } from "./stripHtml";

type Filter = "popular" | "albums" | "singles";

export function ArtistPage() {
  const { id } = useParams();
  const { t } = useTranslation();
  const query = useArtist(id);

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
      <p className="p-6 text-subdued">{missing ? t("artist.notFound") : describeError(t, query.error)}</p>
    );
  }
  return <ArtistView artist={query.data} />;
}

function ArtistView({ artist }: { artist: ArtistDetail }) {
  const { t } = useTranslation();
  const provider = useProvider();
  const info = useArtistInfo(artist.id).data ?? null;
  const topTracks = useTopTracks(artist.name, artist.id).data ?? [];
  const setStarred = useSetStarred();
  const playing = useIsContextPlaying("artist", artist.id);
  const context = { type: "artist" as const, id: artist.id, name: artist.name };

  function play() {
    playOrToggle(context, loaders.artist(provider, artist.id, artist.name));
  }

  function toggleFollow() {
    const starred = !artist.starred;
    setStarred.mutate(
      { kind: "artist", id: artist.id, starred },
      {
        onSuccess: () => toast(starred ? t("artist.followed") : t("artist.unfollowed")),
        onError: (error) => toastError(describeError(t, error)),
      },
    );
  }

  const followButton = (
    <Button
      variant="secondary"
      size="sm"
      aria-pressed={artist.starred}
      onClick={toggleFollow}
      disabled={setStarred.isPending}
    >
      {artist.starred ? t("artist.following") : t("artist.follow")}
    </Button>
  );

  return (
    <div className="flex flex-col gap-10 pb-10">
      <div>
        {info?.imageUrl ? (
          <>
            <div className="@container relative h-[40vh] min-h-64 overflow-hidden">
              <img
                src={info.imageUrl}
                alt=""
                draggable={false}
                className="absolute inset-0 size-full object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-surface via-black/30 to-black/20" />
              <h1 className="absolute bottom-6 left-6 line-clamp-2 pr-6 text-[clamp(2.5rem,8cqw,6rem)] leading-none font-extrabold tracking-tight break-words">
                {artist.name}
              </h1>
            </div>
            <div className="flex items-center gap-6 px-6 pt-6">
              <PlayButton playing={playing} onClick={play} />
              {followButton}
            </div>
          </>
        ) : (
          <PageHeader
            kind={t("artist.kind")}
            title={artist.name}
            cover={artist.cover}
            coverFallback="artist"
            round
            playing={playing}
            onPlay={play}
            actions={followButton}
          />
        )}
      </div>

      <PopularTracks tracks={topTracks} context={context} />
      <Discography albums={artist.albums} />
      <SimilarArtists info={info} />
      <About info={info} />
    </div>
  );
}

function PopularTracks({
  tracks,
  context,
}: {
  tracks: Track[];
  context: { type: "artist"; id: string; name: string };
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  if (tracks.length === 0) return null;
  const visible = tracks.slice(0, expanded ? 10 : 5);

  return (
    <section className="flex flex-col gap-2 px-6">
      <h2 className="text-2xl font-bold tracking-tight">{t("artist.popular")}</h2>
      <TrackList
        tracks={visible}
        showAlbum={false}
        onPlay={(index) => usePlayer.getState().playTracks(visible, index, context)}
      />
      {tracks.length > 5 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="self-start text-sm font-bold text-subdued hover:text-text"
        >
          {expanded ? t("artist.showLess") : t("artist.showMore")}
        </button>
      )}
    </section>
  );
}

function Discography({ albums }: { albums: Album[] }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<Filter>("popular");

  const shown = useMemo(() => {
    switch (filter) {
      case "albums":
        return albums.filter((a) => !a.releaseType || a.releaseType === "album");
      case "singles":
        return albums.filter((a) => a.releaseType === "single" || a.releaseType === "ep");
      default:
        return [...albums].sort((a, b) => (b.playCount ?? 0) - (a.playCount ?? 0));
    }
  }, [albums, filter]);

  if (albums.length === 0) return null;

  const filters: { id: Filter; label: string }[] = [
    { id: "popular", label: t("artist.filterPopular") },
    { id: "albums", label: t("artist.filterAlbums") },
    { id: "singles", label: t("artist.filterSingles") },
  ];

  const typeLabel = (a: Album) => {
    switch (a.releaseType) {
      case "single":
        return t("artist.typeSingle");
      case "ep":
        return t("artist.typeEp");
      case "compilation":
        return t("artist.typeCompilation");
      case "live":
        return t("artist.typeLive");
      default:
        return t("artist.typeAlbum");
    }
  };

  return (
    <section className="flex flex-col gap-3 px-3">
      <h2 className="px-3 text-2xl font-bold tracking-tight">{t("artist.discography")}</h2>
      <div role="group" aria-label={t("artist.filters")} className="flex flex-wrap gap-2 px-3">
        {filters.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              "h-8 rounded-full px-4 text-sm font-medium transition-colors",
              filter === f.id ? "bg-text text-[var(--color-base)]" : "bg-highlight text-text hover:bg-press",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="px-3 py-4 text-subdued">{t("artist.noReleases")}</p>
      ) : (
        <CardGrid
          items={shown}
          getKey={(a) => a.id}
          renderItem={(a) => (
            <MediaCard
              title={a.name}
              subtitle={[a.year, typeLabel(a)].filter((v) => v != null).join(" • ")}
              cover={a.cover}
              to={`/album/${a.id}`}
            />
          )}
        />
      )}
    </section>
  );
}

function SimilarArtists({ info }: { info: ArtistInfo | null }) {
  const { t } = useTranslation();
  const similar = info?.similarArtists ?? [];
  return (
    <div className="px-3">
      <Shelf
        title={t("artist.fansAlsoLike")}
        items={similar}
        getKey={(a) => a.id}
        renderItem={(a) => (
          <MediaCard
            title={a.name}
            subtitle={t("artist.kind")}
            cover={a.cover}
            to={`/artist/${a.id}`}
            round
            fallback="artist"
          />
        )}
      />
    </div>
  );
}

function About({ info }: { info: ArtistInfo | null }) {
  const { t } = useTranslation();
  const text = info?.biography ? stripHtml(info.biography) : "";
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !expanded) setOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [text, expanded]);

  if (!text) return null;

  return (
    <section className="px-6">
      <div className="flex flex-col gap-3 rounded-lg bg-elevated p-6">
        <h2 className="text-2xl font-bold tracking-tight">{t("artist.about")}</h2>
        <p ref={ref} className={cn("text-subdued whitespace-pre-line", !expanded && "line-clamp-6")}>
          {text}
        </p>
        {(overflowing || expanded) && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="self-start text-sm font-bold hover:underline"
          >
            {expanded ? t("artist.readLess") : t("artist.readMore")}
          </button>
        )}
      </div>
    </section>
  );
}
