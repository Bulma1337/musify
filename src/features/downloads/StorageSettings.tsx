import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { AlertDialog } from "radix-ui";
import { Button } from "@/components/ui/Button";
import { toast, toastError } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { CACHE_LIMITS_GB, useSettings } from "@/settings/store";
import { removeAllDownloads } from "./actions";
import { cacheApi, downloadsApi } from "./api";
import { errorMessage } from "./errors";
import { formatBytes } from "./format";
import { useDownloads, useDownloadsAvailable } from "./store";
import type { MoveProgress } from "./types";

const dialogOverlay = "fixed inset-0 z-50 bg-black/60";
const dialogContent =
  "fixed top-1/2 left-1/2 z-50 w-[min(480px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-elevated p-6 shadow-[0_16px_48px_rgb(0_0_0/0.5)] outline-none";

function Row({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-4">
      <div className="min-w-0 flex-1 basis-64">
        <h3 className="font-bold">{title}</h3>
        {description && <div className="mt-0.5 text-sm break-words text-subdued">{description}</div>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

/**
 * Settings section "Speicher": downloads folder, sizes of downloads and streaming cache, cache limit,
 * "clear cache" and "remove all downloads". Self-contained so the settings page can embed it as is.
 */
export function StorageSettings() {
  const { t } = useTranslation();
  const available = useDownloadsAvailable();
  const cacheLimitGb = useSettings((s) => s.cacheLimitGb);
  const setSetting = useSettings((s) => s.set);
  const doneCount = useDownloads((s) => Object.values(s.entries).filter((e) => e.state === "done").length);
  const [move, setMove] = useState<MoveProgress | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [clearing, setClearing] = useState(false);

  // Sizes change whenever a download finishes or is removed, so the count is part of the key.
  const storageQuery = useQuery({
    queryKey: ["downloads", "storage", doneCount],
    queryFn: () => downloadsApi.storageInfo(),
    enabled: available,
    staleTime: 0,
  });
  const cacheQuery = useQuery({
    queryKey: ["downloads", "cache", doneCount],
    queryFn: () => cacheApi.info(),
    enabled: available,
    staleTime: 0,
  });
  const storage = storageQuery.data ?? null;
  const cache = cacheQuery.data ?? null;
  const { refetch: refetchStorage } = storageQuery;
  const { refetch: refetchCache } = cacheQuery;
  const refresh = () => {
    void refetchStorage();
    void refetchCache();
  };

  if (!available) {
    return (
      <section className="py-6">
        <h2 className="text-2xl font-bold tracking-tight">{t("downloads.storage.title")}</h2>
        <p className="mt-2 text-subdued">{t("downloads.storage.unavailable")}</p>
      </section>
    );
  }

  async function changeFolder() {
    const picked = await openFolderDialog({
      directory: true,
      multiple: false,
      defaultPath: storage?.dir,
    });
    if (typeof picked !== "string" || picked === storage?.dir) return;
    setMove({ movedBytes: 0, totalBytes: 0, movedFiles: 0, totalFiles: 0, done: false });
    try {
      await downloadsApi.setDir(picked, setMove);
      toast(t("downloads.storage.moved"));
      await useDownloads.getState().load(useDownloads.getState().serverId ?? "", { force: true });
    } catch (error) {
      const message = errorMessage(t, error);
      toastError(
        message === "busy" ? t("downloads.storage.moveBusy") : t("downloads.storage.moveFailed", { message }),
      );
    } finally {
      setMove(null);
      refresh();
    }
  }

  async function clearCache() {
    setClearing(true);
    try {
      await cacheApi.clear();
      toast(t("downloads.storage.cacheCleared"));
    } catch (error) {
      toastError(errorMessage(t, error));
    } finally {
      setClearing(false);
      refresh();
    }
  }

  async function removeAll() {
    try {
      await removeAllDownloads();
      toast(t("downloads.storage.removeAllDone"));
    } catch (error) {
      toastError(errorMessage(t, error));
    } finally {
      refresh();
    }
  }

  const moving = move !== null;
  const movePercent = move && move.totalBytes > 0 ? (move.movedBytes / move.totalBytes) * 100 : 0;

  return (
    <section className="py-6" aria-labelledby="storage-title">
      <h2 id="storage-title" className="text-2xl font-bold tracking-tight">
        {t("downloads.storage.title")}
      </h2>
      <div className="mt-2 divide-y divide-divider">
        <Row title={t("downloads.storage.folder")} description={storage?.dir ?? "…"}>
          <Button
            variant="secondary"
            size="sm"
            disabled={moving || !storage || storage.busy}
            title={storage?.busy ? t("downloads.storage.moveBusy") : undefined}
            onClick={() => void changeFolder()}
          >
            {t("downloads.storage.change")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!storage}
            onClick={() => storage && void revealItemInDir(storage.dir).catch(() => {})}
          >
            {t("downloads.storage.open")}
          </Button>
        </Row>
        {move && (
          <div className="py-3" role="status">
            <p className="mb-2 text-sm text-subdued">
              {t("downloads.storage.moving", { moved: move.movedFiles, total: move.totalFiles })}
            </p>
            <div className="h-1.5 overflow-hidden rounded-full bg-highlight">
              <div className="h-full bg-accent accent-fill transition-[width]" style={{ width: `${movePercent}%` }} />
            </div>
          </div>
        )}

        <Row
          title={t("downloads.storage.downloads")}
          description={
            storage
              ? `${formatBytes(storage.downloadsBytes)} • ${t("downloads.storage.downloadsDetail", { count: storage.trackCount })}`
              : "…"
          }
        >
          <Button
            variant="secondary"
            size="sm"
            disabled={moving || !storage || (storage.trackCount === 0 && storage.downloadsBytes === 0)}
            onClick={() => setConfirmRemove(true)}
          >
            {t("downloads.storage.removeAll")}
          </Button>
        </Row>

        <Row
          title={t("downloads.storage.cache")}
          description={
            <>
              <p>{cache ? formatBytes(cache.sizeBytes) : "…"}</p>
              <p className="mt-1">{t("downloads.storage.cacheHint")}</p>
            </>
          }
        >
          <Button variant="secondary" size="sm" loading={clearing} onClick={() => void clearCache()}>
            {t("downloads.storage.clearCache")}
          </Button>
        </Row>

        <Row title={t("downloads.storage.cacheLimit")}>
          <div role="radiogroup" aria-label={t("downloads.storage.cacheLimit")} className="flex gap-1">
            {CACHE_LIMITS_GB.map((gb) => (
              <button
                key={gb}
                type="button"
                role="radio"
                aria-checked={cacheLimitGb === gb}
                onClick={() => setSetting("cacheLimitGb", gb)}
                className={cn(
                  "h-8 rounded-full px-3 text-sm transition-colors",
                  cacheLimitGb === gb ? "bg-text text-black" : "bg-highlight text-text hover:bg-press",
                )}
              >
                {t("downloads.storage.gigabytes", { count: gb })}
              </button>
            ))}
          </div>
        </Row>
      </div>

      <AlertDialog.Root open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={dialogOverlay} />
          <AlertDialog.Content className={dialogContent}>
            <AlertDialog.Title className="text-2xl font-bold tracking-tight">
              {t("downloads.storage.removeAllTitle")}
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-3 text-subdued">
              {t("downloads.storage.removeAllBody")}
            </AlertDialog.Description>
            <div className="mt-6 flex justify-end gap-3">
              <AlertDialog.Cancel asChild>
                <Button variant="ghost">{t("downloads.storage.cancel")}</Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button variant="danger" onClick={() => void removeAll()}>
                  {t("downloads.storage.removeAll")}
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </section>
  );
}
