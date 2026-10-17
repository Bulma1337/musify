import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ListPlus } from "lucide-react";
import { describeError } from "@/api/errors";
import { useProvider } from "@/api/session";
import { PageHeader } from "@/components/media/PageHeader";
import { TrackList } from "@/components/media/TrackList";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { toast, toastError } from "@/components/ui/toast";
import { readAccentColor } from "@/features/liked/accentColor";
import { formatLongDuration } from "@/lib/format";
import { useIsContextPlaying } from "@/player/actions";
import { usePlayer } from "@/player/store";
import { AutoCover } from "./AutoCover";
import { autoContextId, parseAutoSlug, type AutoRef } from "./autoPlaylists";
import { useAutoPlaylist } from "./queries";
import { savedPlaylistName, saveAutoPlaylist } from "./saveAuto";
import { useAutoTitle } from "./useAutoTitle";

/** An automatic playlist: tracks computed from the listening history, playable and saveable. */
export function AutoPlaylistPage() {
  const { t } = useTranslation();
  const { slug } = useParams();
  const auto = parseAutoSlug(slug);
  if (!auto) return <p className="p-6 text-subdued">{t("autoPlaylists.notFound")}</p>;
  return <AutoPlaylistView auto={auto} />;
}

function AutoPlaylistView({ auto }: { auto: AutoRef }) {
  const { t } = useTranslation();
  const provider = useProvider();
  const client = useQueryClient();
  const navigate = useNavigate();
  const title = useAutoTitle(auto);
  const query = useAutoPlaylist(auto);
  const [saving, setSaving] = useState(false);
  const contextId = autoContextId(auto);
  const playing = useIsContextPlaying("mix", contextId);
  const context = { type: "mix" as const, id: contextId, name: title };
  const tracks = query.data?.tracks ?? [];

  function play() {
    const player = usePlayer.getState();
    if (player.context?.type === "mix" && player.context.id === contextId && player.current) {
      player.togglePlay();
    } else {
      player.playTracks(tracks, 0, context);
    }
  }

  async function save() {
    setSaving(true);
    try {
      const name = savedPlaylistName(title, auto);
      const playlist = await saveAutoPlaylist(provider, client, name, tracks);
      toast(t("autoPlaylists.saved", { name }));
      navigate(`/playlist/${playlist.id}`);
    } catch (error) {
      toastError(describeError(t, error));
    } finally {
      setSaving(false);
    }
  }

  if (query.isPending) {
    return (
      <div className="grid h-64 place-items-center text-subdued">
        <Spinner />
      </div>
    );
  }
  if (query.isError) return <p className="p-6 text-subdued">{describeError(t, query.error)}</p>;

  const durationMs = tracks.reduce((sum, track) => sum + track.durationMs, 0);

  return (
    <div>
      <PageHeader
        kind={t("autoPlaylists.kind")}
        title={title}
        art={<AutoCover auto={auto} />}
        color={readAccentColor()}
        description={t(`autoPlaylists.description.${auto.kind}`, { year: auto.year })}
        meta={
          <>
            <span className="font-bold">{provider.server.username}</span>
            {tracks.length > 0 && (
              <span>
                <span className="mx-1">•</span>
                {t("autoPlaylists.trackCount", { count: tracks.length })}, {formatLongDuration(durationMs)}
              </span>
            )}
          </>
        }
        playing={playing}
        onPlay={play}
        actions={
          tracks.length > 0 && (
            <Button
              variant="secondary"
              size="sm"
              icon={<ListPlus size={16} />}
              loading={saving}
              onClick={() => void save()}
            >
              {t("autoPlaylists.save")}
            </Button>
          )
        }
      />
      <div className="px-6 pb-8">
        {tracks.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <h2 className="text-2xl font-bold tracking-tight">{t("autoPlaylists.emptyTitle")}</h2>
            <p className="max-w-sm text-subdued">{t("autoPlaylists.emptyHint")}</p>
          </div>
        ) : (
          <TrackList
            tracks={tracks}
            onPlay={(index) => usePlayer.getState().playTracks(tracks, index, context)}
          />
        )}
      </div>
    </div>
  );
}
