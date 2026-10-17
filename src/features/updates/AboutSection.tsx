import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { SettingRow, SettingsSection } from "@/features/settings/controls";
import { inTauri } from "@/lib/platform";
import { useSettings } from "@/settings/store";
import { checkForUpdate, installUpdate, useUpdates } from "./updater";

interface AppInfo {
  name: string;
  version: string;
}

const REPO_URL = "https://github.com/Bulma1337/musify";

/** Settings → About: version, updates, project link. */
export function AboutSection() {
  const { t } = useTranslation();
  const autoUpdate = useSettings((s) => s.autoUpdate);
  const set = useSettings((s) => s.set);
  const { status, version, notes, progress, error } = useUpdates();
  const info = useQuery({
    queryKey: ["app-info"],
    queryFn: () => invoke<AppInfo>("app_info"),
    enabled: inTauri,
    staleTime: Infinity,
  });

  const statusText =
    status === "checking"
      ? t("updates.checking")
      : status === "upToDate"
        ? t("updates.upToDate")
        : status === "downloading"
          ? t("updates.downloading", {
              version,
              percent: progress === null ? "…" : `${Math.round(progress * 100)} %`,
            })
          : status === "ready"
            ? t("updates.ready", { version })
            : status === "installing"
              ? t("updates.installing")
              : status === "error"
                ? t("updates.failed", { message: error })
                : status === "unavailable"
                  ? t("updates.desktopOnly")
                  : "";

  return (
    <SettingsSection id="settings-about" title={t("updates.title")}>
      <SettingRow
        title={t("updates.version", { version: info.data?.version ?? "–" })}
        description={statusText || undefined}
      >
        {status === "ready" ? (
          <Button onClick={() => void installUpdate()}>{t("updates.restart")}</Button>
        ) : (
          <Button
            variant="secondary"
            disabled={
              !inTauri || status === "checking" || status === "downloading" || status === "installing"
            }
            onClick={() => void checkForUpdate({ manual: true })}
          >
            {t("updates.check")}
          </Button>
        )}
      </SettingRow>
      {notes && (status === "downloading" || status === "ready") && (
        <div className="py-4">
          <p className="font-bold">{t("updates.notes", { version })}</p>
          <p className="mt-1 text-[13px] whitespace-pre-line text-subdued">{notes}</p>
        </div>
      )}
      <SettingRow title={t("updates.auto")} description={t("updates.autoHint")}>
        <Switch
          checked={autoUpdate}
          onCheckedChange={(on) => set("autoUpdate", on)}
          label={t("updates.auto")}
        />
      </SettingRow>
      <SettingRow title={t("updates.project")} description={t("updates.projectHint")}>
        <Button
          variant="ghost"
          onClick={() => {
            if (!inTauri) {
              window.open(REPO_URL, "_blank", "noopener");
              return;
            }
            void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(REPO_URL));
          }}
        >
          GitHub
        </Button>
      </SettingRow>
    </SettingsSection>
  );
}
