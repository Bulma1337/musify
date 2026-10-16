import { useMemo } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { useGenres } from "@/api/queries";
import { describeError } from "@/api/errors";
import { Spinner } from "@/components/ui/Spinner";
import { genreColor } from "./genreColor";

/** "Alles durchsuchen": colorful genre tiles shown while the search field is empty. */
export function GenreGrid() {
  const { t } = useTranslation();
  const genres = useGenres();
  const sorted = useMemo(
    () => [...(genres.data ?? [])].sort((a, b) => (b.albumCount ?? 0) - (a.albumCount ?? 0)),
    [genres.data],
  );

  return (
    <section className="flex flex-col gap-4 px-6 py-6">
      <h1 className="text-2xl font-bold tracking-tight">{t("search.browseAll")}</h1>
      {genres.isPending ? (
        <div className="grid h-40 place-items-center text-subdued">
          <Spinner />
        </div>
      ) : genres.isError ? (
        <p className="text-subdued">{describeError(t, genres.error)}</p>
      ) : sorted.length === 0 ? (
        <p className="text-subdued">{t("search.noGenres")}</p>
      ) : (
        <div className="grid gap-6" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
          {sorted.map((genre) => (
            <Link
              key={genre.name}
              to={`/genre/${encodeURIComponent(genre.name)}`}
              style={{ backgroundColor: genreColor(genre.name) }}
              className="relative flex h-[180px] flex-col overflow-hidden rounded-lg p-4 text-white transition-transform hover:scale-[1.02] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text"
            >
              <span className="line-clamp-2 text-xl leading-tight font-bold break-words">{genre.name}</span>
              {genre.albumCount ? (
                <span className="mt-auto text-sm text-white/75">
                  {t("search.albumsCount", { count: genre.albumCount })}
                </span>
              ) : null}
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
