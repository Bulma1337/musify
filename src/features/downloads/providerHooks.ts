import { ProviderError, type MusicProvider } from "@/api/provider";
import { FAVORITES_ID, removeCollectionDownload, scheduleSync } from "./actions";

export interface ProviderHooks {
  /** A request failed because the server could not be reached. */
  onNetworkError(): void;
}

export function isNetworkError(error: unknown): boolean {
  return error instanceof ProviderError && (error.kind === "network" || error.kind === "timeout");
}

/** Keeps downloaded playlists and the favorites in line after the user changed them on the server. */
function afterSuccess(provider: MusicProvider, method: string, args: unknown[]): void {
  const first = typeof args[0] === "string" ? args[0] : undefined;
  switch (method) {
    case "setStarred":
      if (first === "track") scheduleSync(provider, "favorites", FAVORITES_ID);
      break;
    case "addToPlaylist":
    case "removeFromPlaylist":
    case "reorderPlaylist":
    case "updatePlaylist":
      if (first) scheduleSync(provider, "playlist", first);
      break;
    case "deletePlaylist":
      if (first) {
        removeCollectionDownload(provider.server.id, "playlist", first).catch((error) => {
          console.warn("Could not remove the downloads of a deleted playlist", error);
        });
      }
      break;
  }
}

/**
 * Wraps a connected provider without changing the `MusicProvider` interface:
 * - reports requests that fail with a network error, so the app can switch to offline mode;
 * - re-syncs downloaded playlists and favorites after they were modified.
 */
export function decorateProvider(provider: MusicProvider, hooks: ProviderHooks): MusicProvider {
  return new Proxy(provider, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      const method = String(property);
      return (...args: unknown[]) => {
        const result: unknown = Reflect.apply(value, target, args);
        if (!(result instanceof Promise)) return result;
        return result.then(
          (resolved: unknown) => {
            afterSuccess(target, method, args);
            return resolved;
          },
          (error: unknown) => {
            if (isNetworkError(error)) hooks.onNetworkError();
            throw error;
          },
        );
      };
    },
  });
}
