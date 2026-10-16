import { useMemo, useState } from "react";
import { NavLink, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { DropdownMenu } from "radix-ui";
import { ArrowDownUp, Check, Library, Plus, Search, Volume2, X } from "lucide-react";
import type { CoverRef } from "@/api/provider";
import { usePlaylists, useStarred } from "@/api/queries";
import { useProvider } from "@/api/session";
import { describeError } from "@/api/errors";
import { Cover } from "@/components/media/Cover";
import { menuContent, menuItem } from "@/components/media/TrackMenu";
import { IconButton } from "@/components/ui/Button";
import { toastError } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { usePlayer } from "@/player/store";
import { useLayout } from "./layoutStore";

type Filter = "playlists" | "albums" | "artists";
type Sort = "recent" | "alphabetical" | "creator";

interface LibraryEntry {
  key: string;
  kind: "liked" | "playlist" | "album" | "artist";
  id?: string;
  title: string;
  subtitle: string;
  cover?: CoverRef;
  to: string;
  /** For sorting by "recently added". */
  date?: string;
  creator?: string;
}

function useLibraryEntries(): LibraryEntry[] {
  const { t } = useTranslation();
  const playlists = usePlaylists();
  const starred = useStarred();

  return useMemo(() => {
    const entries: LibraryEntry[] = [
      {
        key: "liked",
        kind: "liked",
        title: t("library.likedSongs"),
        subtitle: t("library.likedSubtitle", { count: starred.data?.tracks.length ?? 0 }),
        to: "/liked",
      },
    ];
    for (const p of playlists.data ?? []) {
      entries.push({
        key: `p:${p.id}`,
        kind: "playlist",
        id: p.id,
        title: p.name,
        subtitle: t("library.playlistBy", { owner: p.owner ?? "" }),
        cover: p.cover,
        to: `/playlist/${p.id}`,
        date: p.changedAt ?? p.createdAt,
        creator: p.owner,
      });
    }
    for (const a of starred.data?.albums ?? []) {
      entries.push({
        key: `al:${a.id}`,
        kind: "album",
        id: a.id,
        title: a.name,
        subtitle: t("library.albumBy", { artist: a.artistLine }),
        cover: a.cover,
        to: `/album/${a.id}`,
        date: a.starredAt,
        creator: a.artistLine,
      });
    }
    for (const a of starred.data?.artists ?? []) {
      entries.push({
        key: `ar:${a.id}`,
        kind: "artist",
        id: a.id,
        title: a.name,
        subtitle: t("library.artist"),
        cover: a.cover,
        to: `/artist/${a.id}`,
        date: a.starredAt,
        creator: a.name,
      });
    }
    return entries;
  }, [playlists.data, starred.data, t]);
}

const FILTER_KINDS: Record<Filter, LibraryEntry["kind"][]> = {
  playlists: ["liked", "playlist"],
  albums: ["album"],
  artists: ["artist"],
};

function LibraryItem({ entry, collapsed }: { entry: LibraryEntry; collapsed: boolean }) {
  const playing = usePlayer(
    (s) =>
      s.isPlaying &&
      !!s.context &&
      ((entry.kind === "liked" && s.context.type === "liked") ||
        (s.context.type === entry.kind && s.context.id === entry.id)),
  );

  return (
    <NavLink
      to={entry.to}
      title={collapsed ? entry.title : undefined}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-3 rounded-md p-2 transition-colors hover:bg-highlight",
          isActive && "bg-highlight hover:bg-press",
        )
      }
    >
      <Cover
        cover={entry.cover}
        size={48}
        round={entry.kind === "artist"}
        fallback={entry.kind === "liked" ? "liked" : entry.kind}
        className="w-12 shadow-none"
      />
      {!collapsed && (
        <>
          <div className="min-w-0 flex-1">
            <p className={cn("truncate", playing && "text-accent")}>{entry.title}</p>
            <p className="truncate text-sm text-subdued">{entry.subtitle}</p>
          </div>
          {playing && <Volume2 size={16} className="shrink-0 text-accent" />}
        </>
      )}
    </NavLink>
  );
}

/** Left sidebar ("Bibliothek"): playlists, saved albums and artists with filters, search and sorting. */
export function LibrarySidebar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const provider = useProvider();
  const client = useQueryClient();
  const collapsed = useLayout((s) => s.libraryCollapsed);
  const toggleLibrary = useLayout((s) => s.toggleLibrary);
  const entries = useLibraryEntries();
  const [filter, setFilter] = useState<Filter | null>(null);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [sort, setSort] = useState<Sort>("recent");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = entries.filter(
      (e) =>
        (!filter || FILTER_KINDS[filter].includes(e.kind)) &&
        (!q || e.title.toLowerCase().includes(q) || e.subtitle.toLowerCase().includes(q)),
    );
    const liked = filtered.filter((e) => e.kind === "liked");
    const rest = filtered.filter((e) => e.kind !== "liked");
    rest.sort((a, b) => {
      if (sort === "alphabetical") return a.title.localeCompare(b.title);
      if (sort === "creator") return (a.creator ?? "").localeCompare(b.creator ?? "");
      return (b.date ?? "").localeCompare(a.date ?? "");
    });
    return [...liked, ...rest];
  }, [entries, filter, query, sort]);

  async function createPlaylist() {
    try {
      const playlist = await provider.createPlaylist(t("library.newPlaylistName", { n: entries.length }));
      await client.invalidateQueries({ queryKey: [provider.server.id, "playlists"] });
      navigate(`/playlist/${playlist.id}`);
    } catch (error) {
      toastError(describeError(t, error));
    }
  }

  const chip = (value: Filter, label: string) => (
    <button
      type="button"
      onClick={() => setFilter(filter === value ? null : value)}
      className={cn(
        "h-8 shrink-0 rounded-full px-3 text-sm transition-colors",
        filter === value ? "bg-text text-black" : "bg-highlight text-text hover:bg-press",
      )}
    >
      {label}
    </button>
  );

  const sortLabels: Record<Sort, string> = {
    recent: t("library.sortRecent"),
    alphabetical: t("library.sortAlphabetical"),
    creator: t("library.sortCreator"),
  };

  return (
    <aside className="flex h-full min-h-0 flex-col rounded-lg bg-surface">
      <div className={cn("flex items-center gap-2 px-4 pt-3 pb-2", collapsed && "flex-col px-2")}>
        <button
          type="button"
          onClick={toggleLibrary}
          title={collapsed ? t("library.expand") : t("library.collapse")}
          className="flex min-w-0 items-center gap-3 font-bold text-subdued transition-colors hover:text-text"
        >
          <Library size={24} className="shrink-0" />
          {!collapsed && <span className="truncate text-text">{t("library.title")}</span>}
        </button>
        {!collapsed && <div className="flex-1" />}
        <IconButton
          label={t("library.create")}
          onClick={() => void createPlaylist()}
          className="bg-highlight"
        >
          <Plus size={18} />
        </IconButton>
      </div>

      {!collapsed && (
        <>
          <div className="flex items-center gap-2 overflow-x-auto px-4 py-2">
            {filter && (
              <IconButton
                label={t("library.clearFilter")}
                size={32}
                onClick={() => setFilter(null)}
                className="bg-highlight"
              >
                <X size={16} />
              </IconButton>
            )}
            {chip("playlists", t("library.playlists"))}
            {chip("albums", t("library.albums"))}
            {chip("artists", t("library.artists"))}
          </div>

          <div className="flex items-center justify-between gap-2 px-4 pt-1 pb-2">
            {searchOpen ? (
              <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md bg-highlight px-2">
                <Search size={16} className="shrink-0 text-subdued" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onBlur={() => !query && setSearchOpen(false)}
                  placeholder={t("library.searchPlaceholder")}
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-subdued"
                />
              </label>
            ) : (
              <IconButton label={t("library.search")} onClick={() => setSearchOpen(true)}>
                <Search size={16} />
              </IconButton>
            )}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger className="flex shrink-0 items-center gap-2 text-sm text-subdued hover:text-text">
                {sortLabels[sort]}
                <ArrowDownUp size={16} />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="end" className={menuContent}>
                  <DropdownMenu.Label className="px-3 py-2 text-xs font-bold text-subdued">
                    {t("library.sortBy")}
                  </DropdownMenu.Label>
                  {(Object.keys(sortLabels) as Sort[]).map((s) => (
                    <DropdownMenu.Item key={s} className={menuItem} onSelect={() => setSort(s)}>
                      <span className={cn("flex-1", sort === s && "text-accent")}>{sortLabels[s]}</span>
                      {sort === s && <Check size={16} className="text-accent" />}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </>
      )}

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-label={t("library.title")}>
        {visible.map((entry) => (
          <LibraryItem key={entry.key} entry={entry} collapsed={collapsed} />
        ))}
      </nav>
    </aside>
  );
}
