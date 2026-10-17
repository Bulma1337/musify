import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Heart } from "lucide-react";
import { useStarred } from "@/api/queries";
import { useProvider } from "@/api/session";
import { describeError } from "@/api/errors";
import { PageHeader } from "@/components/media/PageHeader";
import { DownloadButton } from "@/features/downloads/DownloadButton";
import { favoritesSpec } from "@/features/downloads/specs";
import { TrackList } from "@/components/media/TrackList";
import { Spinner } from "@/components/ui/Spinner";
import { formatRelativeDate } from "@/lib/format";
import { loaders, playOrToggle, useIsContextPlaying } from "@/player/actions";
import { usePlayer } from "@/player/store";
import { readAccentColor } from "./accentColor";

export function LikedPage() {
  const { t } = useTranslation();
  const provider = useProvider();
  const starred = useStarred();
  const playing = useIsContextPlaying("liked", undefined);
  const context = { type: "liked" as const, name: t("liked.title") };

  // Newest favorite first; tracks without a timestamp keep their server order at the end.
  const tracks = useMemo(() => {
    const time = (iso?: string) => (iso ? Date.parse(iso) || 0 : 0);
    return [...(starred.data?.tracks ?? [])].sort((a, b) => time(b.starredAt) - time(a.starredAt));
  }, [starred.data]);

  if (starred.isPending) {
    return (
      <div className="grid h-64 place-items-center text-subdued">
        <Spinner />
      </div>
    );
  }
  if (starred.isError) {
    return <p className="p-6 text-subdued">{describeError(t, starred.error)}</p>;
  }

  return (
    <div>
      <PageHeader
        kind={t("liked.kind")}
        title={t("liked.title")}
        coverFallback="liked"
        color={readAccentColor()}
        meta={
          <>
            <span className="font-bold">{provider.server.username}</span>
            <span>
              <span className="mx-1">•</span>
              {t("liked.trackCount", { count: tracks.length })}
            </span>
          </>
        }
        playing={playing}
        onPlay={() => playOrToggle(context, loaders.liked(provider))}
        actions={<DownloadButton spec={favoritesSpec(tracks, t("liked.title"), provider.server.username)} />}
      />
      <div className="px-6 pb-8">
        {tracks.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <Heart size={48} className="text-subdued" strokeWidth={1.5} />
            <h2 className="text-2xl font-bold tracking-tight">{t("liked.emptyTitle")}</h2>
            <p className="max-w-sm text-subdued">{t("liked.emptyHint")}</p>
          </div>
        ) : (
          <TrackList
            tracks={tracks}
            addedAt={(track) => formatRelativeDate(track.starredAt)}
            onPlay={(index) => usePlayer.getState().playTracks(tracks, index, context)}
          />
        )}
      </div>
    </div>
  );
}
