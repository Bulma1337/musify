import type { NativeListing } from "@/features/downloads/types";

/**
 * Replacement for `@/features/downloads/api` in tests: every native call is a mock that resolves to a
 * harmless default. Use it as `vi.mock("@/features/downloads/api", () => downloadsApiMock())`.
 */
export function downloadsApiMock() {
  return {
    downloadsApi: {
      subscribe: vi.fn(),
      list: vi.fn(async (): Promise<NativeListing> => ({
        dir: "D:/Music/Musify",
        tracks: [],
        collections: [],
      })),
      enqueue: vi.fn(async () => {}),
      setCollection: vi.fn(async () => {}),
      removeCollection: vi.fn(async () => {}),
      removeTrack: vi.fn(async () => true),
      cancel: vi.fn(async () => {}),
      removeAll: vi.fn(async () => {}),
      storageInfo: vi.fn(async () => ({
        dir: "D:/Music/Musify",
        downloadsBytes: 123_456_789,
        trackCount: 3,
        busy: false,
      })),
      setDir: vi.fn(async () => {}),
      coverSrc: (serverId: string, ref: string) => `navdl://localhost/${serverId}%2F${ref}`,
    },
    cacheApi: {
      info: vi.fn(async () => ({ sizeBytes: 50 * 1024 * 1024, limitBytes: 2 * 1024 * 1024 * 1024 })),
      setLimit: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    },
  };
}
