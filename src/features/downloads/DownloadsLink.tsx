import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import { CircleArrowDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { ProgressRing } from "./DownloadButton";
import { useDownloadsAvailable, useDownloadSummary } from "./store";

/** Title-bar button to the downloads page; shows a progress ring while something is downloading. */
export function DownloadsLink() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const available = useDownloadsAvailable();
  const summary = useDownloadSummary();
  if (!available) return null;
  const active = location.pathname === "/downloads";
  return (
    <button
      type="button"
      onClick={() => navigate("/downloads")}
      aria-label={t("downloads.title")}
      title={t("downloads.title")}
      className={cn(
        "grid size-12 shrink-0 place-items-center rounded-full bg-elevated transition-transform hover:scale-105",
        active ? "text-text" : "text-subdued hover:text-text",
      )}
    >
      {summary.active > 0 ? (
        <ProgressRing progress={summary.progress} size={26} />
      ) : (
        <CircleArrowDown size={22} />
      )}
    </button>
  );
}
