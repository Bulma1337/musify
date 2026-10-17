import { useTranslation } from "react-i18next";
import { ContextMenu } from "radix-ui";
import { CircleArrowDown, CircleX } from "lucide-react";
import type { Track } from "@/api/provider";
import { useIsOffline, useProvider } from "@/api/session";
import { toast, toastError } from "@/components/ui/toast";
import { downloadTracks, removeTrackDownloads } from "./actions";
import { errorMessage } from "./errors";
import { useDownloads, useDownloadsAvailable } from "./store";

/**
 * Context-menu entry "Download" / "Remove download" for the selected tracks. It removes the
 * download when every selected track is downloaded, otherwise it downloads the missing ones.
 */
export function DownloadMenuItem({ tracks, className }: { tracks: Track[]; className: string }) {
  const { t } = useTranslation();
  const provider = useProvider();
  const available = useDownloadsAvailable();
  const offline = useIsOffline();
  const allDone = useDownloads(
    (s) => tracks.length > 0 && tracks.every((tr) => s.entries[tr.id]?.state === "done"),
  );
  if (!available) return null;

  async function download() {
    const entries = useDownloads.getState().entries;
    const missing = tracks.filter((tr) => entries[tr.id]?.state !== "done");
    try {
      await downloadTracks(provider, missing);
      toast(t("downloads.menu.started", { count: missing.length }));
    } catch (error) {
      toastError(t("downloads.error", { message: errorMessage(t, error) }));
    }
  }

  async function remove() {
    try {
      const { removed, kept } = await removeTrackDownloads(
        provider.server.id,
        tracks.map((tr) => tr.id),
      );
      if (removed.length > 0) toast(t("downloads.menu.removed", { count: removed.length }));
      else if (kept.length > 0) toast(t("downloads.menu.kept"));
    } catch (error) {
      toastError(t("downloads.error", { message: errorMessage(t, error) }));
    }
  }

  return allDone ? (
    <ContextMenu.Item className={className} onSelect={() => void remove()}>
      <CircleX size={16} /> {t("downloads.menu.remove")}
    </ContextMenu.Item>
  ) : (
    <ContextMenu.Item
      className={className}
      disabled={offline}
      title={offline ? t("downloads.offline.unavailable") : undefined}
      onSelect={() => void download()}
    >
      <CircleArrowDown size={16} /> {t("downloads.menu.download")}
    </ContextMenu.Item>
  );
}
