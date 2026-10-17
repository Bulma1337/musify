import { useCallback, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { DropdownMenu } from "radix-ui";
import { useShallow } from "zustand/react/shallow";
import {
  ArrowDownUp,
  ChartColumn,
  Check,
  FolderPlus,
  Library,
  ListMusic,
  Plus,
  Search,
  X,
} from "lucide-react";
import { usePlaylists, useSetStarred, useStarred } from "@/api/queries";
import { useProvider } from "@/api/session";
import { describeError } from "@/api/errors";
import { menuContent, menuItem } from "@/components/media/TrackMenu";
import { IconButton } from "@/components/ui/Button";
import { toast, toastError } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import type { DraggedTracks } from "@/lib/dnd";
import { libraryEntryFromCollection } from "@/features/downloads/libraryEntries";
import { useDownloads, useDownloadsAvailable } from "@/features/downloads/store";
import { FolderRow } from "@/features/library/FolderRow";
import { LibraryItem } from "@/features/library/LibraryItem";
import { buildRows, type LibraryEntry } from "@/features/library/libraryModel";
import { useLibrary, useLibraryPrefs } from "@/features/library/libraryStore";
import { useLayout } from "./layoutStore";

type Filter = "playlists" | "albums" | "artists";
type Sort = "recent" | "alphabetical" | "creator";

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
        readOnly: p.readOnly,
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
  const [downloadedOnly, setDownloadedOnly] = useState(false);
  const downloadsAvailable = useDownloadsAvailable();
  const collections = useDownloads(useShallow((s) => Object.values(s.collections)));
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [sort, setSort] = useState<Sort>("recent");
  const [editingFolder, setEditingFolder] = useState<string | null>(null);
  // Radix hands focus back to the "+" button after its menu closes; that would steal it from the rename field.
  const keepFocusOut = useRef(false);
  const serverId = provider.server.id;
  const prefs = useLibraryPrefs(serverId);
  const { mutateAsync: setStarred } = useSetStarred();

  // "Downloaded": only what is stored on this computer, taking server data where we have it.
  const shown = useMemo(() => {
    if (!downloadedOnly) return entries;
    const byKey = new Map(entries.map((e) => [e.key, e]));
    return collections.map((c) => {
      const entry = libraryEntryFromCollection(c, t);
      return byKey.get(entry.key) ?? entry;
    });
  }, [entries, collections, downloadedOnly, t]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = shown.filter(
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
  }, [shown, filter, query, sort]);

  // Filtering or searching shows matching entries flat; otherwise the folder tree (or the icon rail).
  const flat = !!filter || downloadedOnly || query.trim() !== "";
  const rows = useMemo(
    () => buildRows(visible, prefs, flat ? "flat" : collapsed ? "rail" : "tree"),
    [visible, prefs, flat, collapsed],
  );

  const startNewFolder = useCallback(
    (entryKey?: string) => {
      const library = useLibrary.getState();
      const id = library.createFolder(serverId, t("libraryExtras.newFolderName"));
      if (entryKey) library.moveToFolder(serverId, entryKey, id);
      // Make the new folder visible: it is hidden by filters, searches and the collapsed rail.
      setFilter(null);
      setQuery("");
      setSearchOpen(false);
      const layout = useLayout.getState();
      if (layout.libraryCollapsed) layout.toggleLibrary();
      setEditingFolder(id);
    },
    [serverId, t],
  );

  const dropTracks = useCallback(
    async (entry: LibraryEntry, dragged: DraggedTracks) => {
      const ids = dragged.trackIds;
      try {
        if (entry.kind === "liked") {
          await Promise.all(ids.map((id) => setStarred({ kind: "track", id, starred: true })));
        } else if (entry.kind === "playlist" && entry.id) {
          await provider.addToPlaylist(entry.id, ids);
          void client.invalidateQueries({ queryKey: [serverId, "playlist", entry.id] });
          void client.invalidateQueries({ queryKey: [serverId, "playlists"] });
        } else {
          return;
        }
        toast(t("libraryExtras.addedToPlaylist", { count: ids.length, name: entry.title }));
      } catch (error) {
        toastError(describeError(t, error));
      }
    },
    [client, provider, serverId, setStarred, t],
  );

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
        <IconButton label={t("stats.title")} onClick={() => navigate("/stats")}>
          <ChartColumn size={18} />
        </IconButton>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <IconButton label={t("libraryExtras.create")} className="bg-highlight">
              <Plus size={18} />
            </IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              className={menuContent}
              onCloseAutoFocus={(event) => {
                if (keepFocusOut.current) {
                  event.preventDefault();
                  keepFocusOut.current = false;
                }
              }}
            >
              <DropdownMenu.Item className={menuItem} onSelect={() => void createPlaylist()}>
                <ListMusic size={16} /> {t("library.create")}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className={menuItem}
                onSelect={() => {
                  keepFocusOut.current = true;
                  startNewFolder();
                }}
              >
                <FolderPlus size={16} /> {t("libraryExtras.createFolder")}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      {!collapsed && (
        <>
          <div className="flex flex-wrap items-center gap-2 px-4 py-2">
            {(filter || downloadedOnly) && (
              <IconButton
                label={t("library.clearFilter")}
                size={32}
                onClick={() => {
                  setFilter(null);
                  setDownloadedOnly(false);
                }}
                className="bg-highlight"
              >
                <X size={16} />
              </IconButton>
            )}
            {chip("playlists", t("library.playlists"))}
            {chip("albums", t("library.albums"))}
            {chip("artists", t("library.artists"))}
            {downloadsAvailable && (
              <button
                type="button"
                aria-pressed={downloadedOnly}
                onClick={() => setDownloadedOnly(!downloadedOnly)}
                className={cn(
                  "h-8 shrink-0 rounded-full px-3 text-sm transition-colors",
                  downloadedOnly ? "bg-text text-black" : "bg-highlight text-text hover:bg-press",
                )}
              >
                {t("downloads.filterChip")}
              </button>
            )}
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
        {rows.map((row) =>
          row.type === "folder" ? (
            <FolderRow
              key={`folder:${row.folder.id}`}
              folder={row.folder}
              serverId={serverId}
              count={row.count}
              rail={collapsed}
              editing={editingFolder === row.folder.id}
              onEdit={setEditingFolder}
            />
          ) : (
            <LibraryItem
              key={row.entry.key}
              entry={row.entry}
              serverId={serverId}
              collapsed={collapsed}
              depth={row.depth}
              pinned={row.pinned}
              folderId={row.folderId}
              onDropTracks={dropTracks}
              onNewFolder={startNewFolder}
            />
          ),
        )}
      </nav>
    </aside>
  );
}
