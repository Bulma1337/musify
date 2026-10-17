import type { Lyrics, Track } from "@/api/provider";
import { useDownloads } from "@/features/downloads/store";
import { inTauri } from "@/lib/platform";
import { parseLrc } from "./lrc";

/**
 * The `.lrc` next to the downloaded file of `track` (saved with the download or put there by the
 * user), parsed; null if the track is not downloaded or has no such file.
 */
export async function readLocalLyrics(track: Track): Promise<Lyrics | null> {
  if (!inTauri) return null;
  const audioPath = useDownloads.getState().localPath(track.serverId, track.id);
  if (!audioPath) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const text = await invoke<string | null>("downloads_lyrics_read", { audioPath });
    if (!text) return null;
    const lyrics = parseLrc(text, "local");
    return lyrics && lyrics.lines.some((l) => l.text.trim() !== "") ? lyrics : null;
  } catch {
    return null;
  }
}
