import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/api/session";
import { cancelScheduledSyncs, resumePending, syncAll } from "./actions";
import { useDownloads } from "./store";

/**
 * Background work of the downloads feature, mounted once in the app shell:
 * - loads the downloads of the connected server and hands unfinished ones back to the downloader;
 * - syncs downloaded albums, playlists and favorites with the server;
 * - refetches everything on screen when the app goes offline or comes back online.
 */
export function DownloadsController() {
  const provider = useSession((s) => s.provider);
  const offline = useSession((s) => s.offline);
  const client = useQueryClient();

  useEffect(() => {
    if (!provider) return;
    let stale = false;
    void (async () => {
      await useDownloads.getState().load(provider.server.id);
      // Resuming and syncing need the server; offline mode only shows what is there.
      if (stale || offline) return;
      await resumePending(provider);
      if (!stale) await syncAll(provider);
    })().catch((error) => console.warn("Download startup failed", error));
    return () => {
      stale = true;
      cancelScheduledSyncs();
    };
  }, [provider, offline]);

  // The same query keys serve the server and the downloaded library: start over when switching.
  const previous = useRef(offline);
  useEffect(() => {
    if (previous.current === offline) return;
    previous.current = offline;
    void client.resetQueries();
  }, [offline, client]);

  return null;
}
