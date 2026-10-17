import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { readPersisted, writePersisted } from "@/lib/persist";
import type { CoverRef, MusicProvider, Playlist } from "./provider";
import { useSession } from "./session";

/**
 * Playlist images chosen in Musify. Subsonic servers cannot store playlist images, so they live on
 * this computer (as small JPEG data URLs) and replace the server's cover everywhere in the app.
 */
interface CustomCoversState {
  /** `serverId:playlistId` → data URL. */
  images: Record<string, string>;
  setImage(serverId: string, playlistId: string, dataUrl: string): void;
  removeImage(serverId: string, playlistId: string): void;
}

const storage: StateStorage = {
  getItem: async (name) => (await readPersisted<string>("covers.json", name)) ?? null,
  setItem: (name, value) => writePersisted("covers.json", name, value),
  removeItem: (name) => writePersisted("covers.json", name, null),
};

const keyOf = (serverId: string, playlistId: string) => `${serverId}:${playlistId}`;

export const useCustomCovers = create<CustomCoversState>()(
  persist(
    (set) => ({
      images: {},
      setImage: (serverId, playlistId, dataUrl) =>
        set((s) => ({ images: { ...s.images, [keyOf(serverId, playlistId)]: dataUrl } })),
      removeImage: (serverId, playlistId) =>
        set((s) => {
          const images = { ...s.images };
          delete images[keyOf(serverId, playlistId)];
          return { images };
        }),
    }),
    { name: "musify.customCovers", storage: createJSONStorage(() => storage) },
  ),
);

/** Cover refs with this prefix point to a custom image instead of the server's cover art. */
const LOCAL_PREFIX = "local:";

export function hasCustomCover(images: Record<string, string>, serverId: string, playlistId: string): boolean {
  return keyOf(serverId, playlistId) in images;
}

/** The playlist with its custom image as cover, if one was chosen. */
export function withCustomCover<T extends Playlist>(playlist: T, images: Record<string, string>): T {
  const key = keyOf(playlist.serverId, playlist.id);
  return key in images ? { ...playlist, cover: `${LOCAL_PREFIX}${key}` } : playlist;
}

/** Image URL of a cover ref: the custom image for `local:` refs, else the server's cover art. */
export function coverSource(provider: MusicProvider, cover: CoverRef, size: number): string | undefined {
  if (cover.startsWith(LOCAL_PREFIX)) return useCustomCovers.getState().images[cover.slice(LOCAL_PREFIX.length)];
  return provider.coverUrl(cover, size);
}

/** Like {@link coverSource}, and re-renders when a custom image changes. */
export function useCoverSource(cover: CoverRef | undefined, size: number): string | undefined {
  const provider = useSession((s) => s.provider);
  const local = useCustomCovers((s) =>
    cover?.startsWith(LOCAL_PREFIX) ? s.images[cover.slice(LOCAL_PREFIX.length)] : undefined,
  );
  if (!cover || !provider) return undefined;
  return cover.startsWith(LOCAL_PREFIX) ? local : provider.coverUrl(cover, size);
}

/** Edge length of stored images. */
const IMAGE_SIZE = 600;

/** Square, centered crop of an image file as a JPEG data URL. */
export async function imageFileToCover(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = IMAGE_SIZE;
  canvas.height = IMAGE_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no canvas");
  context.imageSmoothingQuality = "high";
  context.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    IMAGE_SIZE,
    IMAGE_SIZE,
  );
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.88);
}
