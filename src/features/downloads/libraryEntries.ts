import type { TFunction } from "i18next";
import type { LibraryEntry } from "@/features/library/libraryModel";
import type { CollectionEntry } from "./types";

/** Sidebar entry for a downloaded collection (used by the "Downloaded" filter, also offline). */
export function libraryEntryFromCollection(c: CollectionEntry, t: TFunction): LibraryEntry {
  switch (c.snapshot.kind) {
    case "favorites":
      return {
        key: "liked",
        kind: "liked",
        title: t("library.likedSongs"),
        subtitle: t("library.likedSubtitle", { count: c.trackIds.length }),
        to: "/liked",
      };
    case "playlist": {
      const p = c.snapshot.playlist;
      return {
        key: `p:${c.itemId}`,
        kind: "playlist",
        id: c.itemId,
        title: c.name,
        subtitle: t("library.playlistBy", { owner: p.owner ?? "" }),
        cover: p.cover,
        to: `/playlist/${c.itemId}`,
        date: p.changedAt ?? p.createdAt,
        creator: p.owner,
        readOnly: true,
      };
    }
    case "album": {
      const a = c.snapshot.album;
      return {
        key: `al:${c.itemId}`,
        kind: "album",
        id: c.itemId,
        title: c.name,
        subtitle: t("library.albumBy", { artist: a.artistLine }),
        cover: a.cover,
        to: `/album/${c.itemId}`,
        date: new Date(c.addedAt).toISOString(),
        creator: a.artistLine,
      };
    }
  }
}
