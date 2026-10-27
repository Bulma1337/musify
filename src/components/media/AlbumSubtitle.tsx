import { Fragment } from "react";
import { Link } from "react-router";
import type { Album } from "@/api/provider";

/** Clicking an artist (or Enter on it) opens the artist, not the album the card links to. */
const stop = (event: { stopPropagation(): void }) => event.stopPropagation();

/** "2015 • Kollegah & Farid Bang" under an album card, with each artist linking to their page. */
export function AlbumSubtitle({ album }: { album: Album }) {
  const artists = album.artists.filter((a) => a.name);
  return (
    <>
      {album.year != null && <span>{album.year}</span>}
      {album.year != null && (artists.length > 0 || album.artistLine) && <span> • </span>}
      {artists.length > 0
        ? artists.map((artist, i) => (
            <Fragment key={`${artist.id ?? artist.name}-${i}`}>
              {i > 0 && <span>{i === artists.length - 1 ? " & " : ", "}</span>}
              {artist.id ? (
                <Link
                  to={`/artist/${artist.id}`}
                  onClick={stop}
                  onKeyDown={stop}
                  className="hover:text-text hover:underline"
                >
                  {artist.name}
                </Link>
              ) : (
                <span>{artist.name}</span>
              )}
            </Fragment>
          ))
        : album.artistLine && <span>{album.artistLine}</span>}
    </>
  );
}
