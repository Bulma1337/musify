import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { readPersisted, writePersisted } from "@/lib/persist";

/** A user-made folder for playlists in the library sidebar (local only, never sent to the server). */
export interface LibraryFolder {
  id: string;
  name: string;
  /** Entry keys (`p:<playlistId>`) in the folder. Only playlists can be filed. */
  entryKeys: string[];
  collapsed: boolean;
}

/** Local library preferences of one server. */
export interface ServerLibraryPrefs {
  /** Entry keys (`p:<id>`, `al:<id>`, `ar:<id>`) in pin order. Favorites ("liked") is always pinned. */
  pinned: string[];
  folders: LibraryFolder[];
}

export const EMPTY_PREFS: ServerLibraryPrefs = Object.freeze({ pinned: [], folders: [] }) as ServerLibraryPrefs;

interface LibraryState {
  /** Preferences per server id, so switching servers never mixes entries up. */
  byServer: Record<string, ServerLibraryPrefs>;

  togglePin(serverId: string, key: string): void;
  /** Creates an expanded, empty folder at the end of the list and returns its id. */
  createFolder(serverId: string, name: string): string;
  renameFolder(serverId: string, folderId: string, name: string): void;
  /** Removes the folder; its playlists are back on the top level. */
  deleteFolder(serverId: string, folderId: string): void;
  toggleFolder(serverId: string, folderId: string): void;
  /** Files a playlist into a folder (`null` = back to the top level). Only `p:` keys can be filed. */
  moveToFolder(serverId: string, key: string, folderId: string | null): void;
}

/** plugin-store in the app, localStorage in the browser preview (via persist.ts). */
const storage: StateStorage = {
  getItem: async (name) => (await readPersisted<string>("library.json", name)) ?? null,
  setItem: (name, value) => writePersisted("library.json", name, value),
  removeItem: (name) => writePersisted("library.json", name, null),
};

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export const useLibrary = create<LibraryState>()(
  persist(
    (set) => {
      const update = (serverId: string, change: (prefs: ServerLibraryPrefs) => ServerLibraryPrefs) =>
        set((s) => ({ byServer: { ...s.byServer, [serverId]: change(s.byServer[serverId] ?? EMPTY_PREFS) } }));
      const editFolder = (serverId: string, folderId: string, change: (f: LibraryFolder) => LibraryFolder) =>
        update(serverId, (p) => ({
          ...p,
          folders: p.folders.map((f) => (f.id === folderId ? change(f) : f)),
        }));

      return {
        byServer: {},

        togglePin: (serverId, key) => {
          if (key === "liked") return;
          update(serverId, (p) => ({
            ...p,
            pinned: p.pinned.includes(key) ? p.pinned.filter((k) => k !== key) : [...p.pinned, key],
          }));
        },

        createFolder: (serverId, name) => {
          const id = newId();
          update(serverId, (p) => ({
            ...p,
            folders: [...p.folders, { id, name: name.trim(), entryKeys: [], collapsed: false }],
          }));
          return id;
        },

        renameFolder: (serverId, folderId, name) => {
          const trimmed = name.trim();
          if (trimmed) editFolder(serverId, folderId, (f) => ({ ...f, name: trimmed }));
        },

        deleteFolder: (serverId, folderId) =>
          update(serverId, (p) => ({ ...p, folders: p.folders.filter((f) => f.id !== folderId) })),

        toggleFolder: (serverId, folderId) =>
          editFolder(serverId, folderId, (f) => ({ ...f, collapsed: !f.collapsed })),

        moveToFolder: (serverId, key, folderId) => {
          if (!key.startsWith("p:")) return;
          update(serverId, (p) => {
            if (folderId !== null && !p.folders.some((f) => f.id === folderId)) return p;
            return {
              ...p,
              folders: p.folders.map((f) => {
                const without = f.entryKeys.filter((k) => k !== key);
                return f.id === folderId ? { ...f, entryKeys: [...without, key] } : { ...f, entryKeys: without };
              }),
            };
          });
        },
      };
    },
    {
      name: "navify.library",
      version: 1,
      storage: createJSONStorage(() => storage),
      partialize: ({ byServer }) => ({ byServer }),
    },
  ),
);

/** The preferences of one server (a stable empty object while nothing is stored). */
export function useLibraryPrefs(serverId: string): ServerLibraryPrefs {
  return useLibrary((s) => s.byServer[serverId]) ?? EMPTY_PREFS;
}
