import { useTranslation } from "react-i18next";
import { CircleArrowDown } from "lucide-react";
import { DownloadedGlyph } from "./DownloadButton";
import { useTrackDownloadState } from "./store";

/** Small marker in track rows: accent circle for downloaded tracks, muted arrow while waiting. */
export function DownloadIndicator({ trackId }: { trackId: string }) {
  const { t } = useTranslation();
  const state = useTrackDownloadState(trackId);
  if (state === "done") {
    return (
      <span title={t("downloads.indicator.done")} className="grid shrink-0 place-items-center">
        <DownloadedGlyph size={16} />
      </span>
    );
  }
  if (state === "queued" || state === "downloading") {
    return (
      <span title={t("downloads.indicator.pending")} className="grid shrink-0 place-items-center text-muted">
        <CircleArrowDown size={16} />
      </span>
    );
  }
  return null;
}
