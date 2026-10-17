import type { Track } from "@/api/provider";
import { useSession } from "@/api/session";
import { toLrc } from "@/features/lyrics/lrc";
import { resolveLyrics } from "@/features/lyrics/useLyrics";
import { inTauri } from "@/lib/platform";
import { useSettings } from "@/settings/store";
import { useDownloads } from "./store";

/**
 * Lyrics files next to downloaded tracks (`<track>.lrc`): read first when showing lyrics (also
 * offline, and the user's own files work too), and written once a download finishes.
 */

async function invokeLyrics<T>(command: string, args: Record<string, unknown>): Promise<T | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<T>(command, args);
  } catch {
    return null;
  }
}

async function saveSidecar(track: Track, audioPath: string) {
  const provider = useSession.getState().provider;
  if (!provider || provider.server.id !== track.serverId) return;
  if (await invokeLyrics<string | null>("downloads_lyrics_read", { audioPath })) return;
  const { lyrics } = await resolveLyrics(provider, track, undefined, {
    online: useSettings.getState().onlineLyrics,
  });
  if (!lyrics || !lyrics.lines.some((l) => l.text.trim() !== "")) return;
  await invokeLyrics<boolean>("downloads_lyrics_write", { audioPath, text: toLrc(lyrics) });
}

/** Writes the lyrics of every track whose download just finished. Returns cleanup. */
export function startLyricsSidecars(): () => void {
  if (!inTauri) return () => {};
  const pending = new Set<string>();
  return useDownloads.subscribe((s, prev) => {
    for (const [id, entry] of Object.entries(s.entries)) {
      if (entry.state !== "done" || !entry.path || prev.entries[id]?.state === "done") continue;
      if (pending.has(id)) continue;
      pending.add(id);
      void saveSidecar(entry.track, entry.path).finally(() => pending.delete(id));
    }
  });
}
