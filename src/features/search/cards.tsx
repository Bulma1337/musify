import { useTranslation } from "react-i18next";
import type { Album, Artist } from "@/api/provider";
import { useProvider } from "@/api/session";
import { AlbumSubtitle } from "@/components/media/AlbumSubtitle";
import { MediaCard } from "@/components/media/MediaCard";
import { loaders, playOrToggle, useIsContextPlaying } from "@/player/actions";

export function AlbumResultCard({ album }: { album: Album }) {
  const provider = useProvider();
  const playing = useIsContextPlaying("album", album.id);
  return (
    <MediaCard
      title={album.name}
      subtitle={<AlbumSubtitle album={album} />}
      cover={album.cover}
      to={`/album/${album.id}`}
      fallback="album"
      playing={playing}
      onPlay={() =>
        playOrToggle({ type: "album", id: album.id, name: album.name }, loaders.album(provider, album.id))
      }
    />
  );
}

export function ArtistResultCard({ artist }: { artist: Artist }) {
  const { t } = useTranslation();
  const provider = useProvider();
  const playing = useIsContextPlaying("artist", artist.id);
  return (
    <MediaCard
      title={artist.name}
      subtitle={t("search.typeArtist")}
      cover={artist.cover}
      to={`/artist/${artist.id}`}
      round
      fallback="artist"
      playing={playing}
      onPlay={() =>
        playOrToggle(
          { type: "artist", id: artist.id, name: artist.name },
          loaders.artist(provider, artist.id, artist.name),
        )
      }
    />
  );
}
