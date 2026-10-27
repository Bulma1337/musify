import { useTranslation } from "react-i18next";
import { CircleAlert, CircleArrowDown } from "lucide-react";
import { describeError } from "@/api/errors";
import { useIsOffline, useProvider } from "@/api/session";
import { IconButton } from "@/components/ui/Button";
import { toast, toastError } from "@/components/ui/toast";
import { downloadCollection, removeCollectionDownload, type CollectionSpec } from "./actions";
import { percent } from "./format";
import { useCollectionStatus, useDownloadsAvailable } from "./store";

/**
 * Accent-filled circle with a down arrow: "everything is on this computer". As large as the outlined
 * `CircleArrowDown` it replaces (circle plus half its stroke = 22 of 24 units), with the same arrow, so
 * nothing shrinks when a download completes; filled like the play buttons (gradient accents too).
 */
export function DownloadedGlyph({ size = 28 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="relative grid shrink-0 place-items-center"
      style={{ width: size, height: size }}
    >
      <span className="absolute inset-[4.1667%] rounded-full bg-accent accent-fill" />
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="relative text-on-accent"
      >
        <path d="M12 8v8" />
        <path d="m8 12 4 4 4-4" />
      </svg>
    </span>
  );
}

/** Ring that fills up with `progress` (0…1), with a small stop square inside. */
export function ProgressRing({ progress, size = 28 }: { progress: number; size?: number }) {
  const radius = 10;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="text-accent">
      <circle
        cx="12"
        cy="12"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="2.5"
      />
      <circle
        cx="12"
        cy="12"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={`${circumference * Math.max(0.04, progress)} ${circumference}`}
        transform="rotate(-90 12 12)"
        style={{ transition: "stroke-dasharray 0.3s linear" }}
      />
      <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" />
    </svg>
  );
}

export interface DownloadButtonProps {
  /** What a click downloads. */
  spec: CollectionSpec;
}

/**
 * Download toggle for the header of an album, playlist or the favorites: idle → progress ring while
 * downloading → accent check once everything is on this computer. Click again to cancel or remove.
 */
export function DownloadButton({ spec }: DownloadButtonProps) {
  const { t } = useTranslation();
  const provider = useProvider();
  const available = useDownloadsAvailable();
  const offline = useIsOffline();
  const status = useCollectionStatus(spec.kind, spec.itemId);
  if (!available) return null;

  const downloading = status.registered && status.active > 0;
  const failed = status.registered && !downloading && status.failed > 0;
  const downloaded = status.registered && !downloading && !failed;

  let label = t("downloads.toggle.download");
  if (downloading) label = t("downloads.toggle.downloading", { percent: percent(status.progress) });
  else if (failed) label = t("downloads.toggle.failed");
  else if (downloaded) label = t("downloads.toggle.downloaded");
  else if (offline) label = t("downloads.toggle.needsConnection");

  async function onClick() {
    try {
      if (downloading || downloaded) {
        await removeCollectionDownload(provider.server.id, spec.kind, spec.itemId);
        toast(downloading ? t("downloads.cancelled") : t("downloads.removed"));
      } else {
        await downloadCollection(provider, spec);
        toast(t("downloads.started"));
      }
    } catch (error) {
      toastError(t("downloads.error", { message: describeError(t, error) }));
    }
  }

  return (
    <IconButton
      label={label}
      size={40}
      disabled={offline && !status.registered}
      onClick={() => void onClick()}
    >
      {downloading ? (
        <ProgressRing progress={status.progress} />
      ) : failed ? (
        <CircleAlert size={28} className="text-danger" />
      ) : downloaded ? (
        <DownloadedGlyph />
      ) : (
        <CircleArrowDown size={28} />
      )}
    </IconButton>
  );
}
