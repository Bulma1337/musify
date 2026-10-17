import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { installUpdate, useUpdates } from "./updater";

/** Title-bar notice once an update is downloaded: restart to install. */
export function UpdateButton() {
  const { t } = useTranslation();
  const status = useUpdates((s) => s.status);
  const version = useUpdates((s) => s.version);
  if (status !== "ready" && status !== "installing") return null;
  return (
    <button
      type="button"
      onClick={() => void installUpdate()}
      disabled={status === "installing"}
      title={t("updates.restartHint", { version })}
      className="mx-1 flex h-8 shrink-0 items-center gap-1.5 self-center rounded-full bg-accent accent-fill px-3 text-[13px] font-bold text-on-accent hover:scale-105 disabled:opacity-60"
    >
      <RefreshCw size={14} className={status === "installing" ? "animate-spin" : undefined} />
      {t("updates.restart")}
    </button>
  );
}
