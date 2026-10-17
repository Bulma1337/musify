import type { CoverRef } from "@/api/provider";
import type { LibraryFolder, ServerLibraryPrefs } from "./libraryStore";

export interface LibraryEntry {
  /** `liked`, `p:<id>`, `al:<id>` or `ar:<id>`; also the key used by pins and folders. */
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
  /** Read-only playlists (smart or server-owned) cannot receive tracks. */
  readOnly?: boolean;
}

export type LibraryRow =
  | { type: "entry"; entry: LibraryEntry; depth: 0 | 1; pinned: boolean; folderId?: string }
  | { type: "folder"; folder: LibraryFolder; count: number };

/**
 * - `flat`: filtering or searching; matching entries only, pinned ones first.
 * - `tree`: Favorites, pinned top-level entries, folders with their children, everything else.
 * - `rail`: collapsed sidebar; pinned entries first (also those in folders), then folders as icons
 *   (children only while expanded), then the rest.
 */
export type RowMode = "flat" | "tree" | "rail";

/**
 * Orders already filtered and sorted entries into sidebar rows. Pins win over the sort order; stale keys
 * in the preferences (deleted playlists) are ignored.
 */
export function buildRows(
  entries: readonly LibraryEntry[],
  prefs: ServerLibraryPrefs,
  mode: RowMode,
): LibraryRow[] {
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const pinOrder = new Map(prefs.pinned.map((key, i) => [key, i]));
  const folderOf = new Map<string, string>();
  if (mode !== "flat") {
    for (const folder of prefs.folders) {
      for (const key of folder.entryKeys) if (!folderOf.has(key)) folderOf.set(key, folder.id);
    }
  }

  const entryRow = (entry: LibraryEntry, depth: 0 | 1, folderId?: string): LibraryRow => ({
    type: "entry",
    entry,
    depth,
    pinned: entry.key === "liked" || pinOrder.has(entry.key),
    folderId,
  });

  const rows: LibraryRow[] = [];
  const liked = byKey.get("liked");
  if (liked) rows.push(entryRow(liked, 0));

  const pinned = prefs.pinned
    .map((key) => byKey.get(key))
    .filter((e): e is LibraryEntry => !!e && e.kind !== "liked");
  for (const entry of pinned) {
    // In the tree, pinned playlists that live in a folder stay inside it.
    if (mode === "tree" && folderOf.has(entry.key)) continue;
    rows.push(entryRow(entry, 0, folderOf.get(entry.key)));
  }

  if (mode !== "flat") {
    for (const folder of prefs.folders) {
      const members = entries.filter((e) => e.kind !== "liked" && folderOf.get(e.key) === folder.id);
      const children =
        mode === "tree"
          ? [
              ...members
                .filter((e) => pinOrder.has(e.key))
                .sort((a, b) => pinOrder.get(a.key)! - pinOrder.get(b.key)!),
              ...members.filter((e) => !pinOrder.has(e.key)),
            ]
          : members.filter((e) => !pinOrder.has(e.key));
      rows.push({ type: "folder", folder, count: members.length });
      if (!folder.collapsed) for (const entry of children) rows.push(entryRow(entry, 1, folder.id));
    }
  }

  for (const entry of entries) {
    if (entry.kind === "liked" || pinOrder.has(entry.key) || folderOf.has(entry.key)) continue;
    rows.push(entryRow(entry, 0));
  }
  return rows;
}
