import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Switch } from "@/components/ui/Switch";
import { toastError } from "@/components/ui/toast";
import { inTauri } from "@/lib/platform";
import { useSettings } from "@/settings/store";
import { SettingRow, SettingsSection } from "./controls";

const AUTOSTART_KEY = ["system", "autostart"];

/** Settings → System: autostart (minimized), close to tray, track notifications, Discord. */
export function SystemSection() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const closeToTray = useSettings((s) => s.closeToTray);
  const notify = useSettings((s) => s.notifyTrackChange);
  const discord = useSettings((s) => s.discordPresence);
  const discordCovers = useSettings((s) => s.discordCovers);
  const set = useSettings((s) => s.set);
  // The OS entry is the source of truth for autostart, not a stored setting.
  const autostart = useQuery({
    queryKey: AUTOSTART_KEY,
    queryFn: async () => (await import("@tauri-apps/plugin-autostart")).isEnabled(),
    enabled: inTauri,
  });

  async function setAutostart(on: boolean) {
    try {
      const plugin = await import("@tauri-apps/plugin-autostart");
      if (on) await plugin.enable();
      else await plugin.disable();
    } catch (error) {
      toastError(String(error));
    } finally {
      void client.invalidateQueries({ queryKey: AUTOSTART_KEY });
    }
  }

  return (
    <SettingsSection
      id="settings-system"
      title={t("settings.system.title")}
      description={inTauri ? t("settings.system.description") : t("settings.system.desktopOnly")}
    >
      <SettingRow title={t("settings.system.autostart")} description={t("settings.system.autostartHint")}>
        <Switch
          checked={autostart.data ?? false}
          disabled={!inTauri || autostart.isPending}
          onCheckedChange={(on) => void setAutostart(on)}
          label={t("settings.system.autostart")}
        />
      </SettingRow>
      <SettingRow title={t("settings.system.closeToTray")} description={t("settings.system.closeToTrayHint")}>
        <Switch
          checked={closeToTray}
          disabled={!inTauri}
          onCheckedChange={(on) => set("closeToTray", on)}
          label={t("settings.system.closeToTray")}
        />
      </SettingRow>
      <SettingRow title={t("settings.system.notify")} description={t("settings.system.notifyHint")}>
        <Switch
          checked={notify}
          disabled={!inTauri}
          onCheckedChange={(on) => set("notifyTrackChange", on)}
          label={t("settings.system.notify")}
        />
      </SettingRow>
      <SettingRow title={t("settings.system.discord")} description={t("settings.system.discordHint")}>
        <Switch
          checked={discord}
          disabled={!inTauri}
          onCheckedChange={(on) => set("discordPresence", on)}
          label={t("settings.system.discord")}
        />
      </SettingRow>
      <SettingRow
        title={t("settings.system.discordCovers")}
        description={t("settings.system.discordCoversHint")}
        disabledReason={discord ? undefined : t("settings.system.needsDiscord")}
      >
        <Switch
          checked={discord && discordCovers}
          disabled={!inTauri || !discord}
          onCheckedChange={(on) => set("discordCovers", on)}
          label={t("settings.system.discordCovers")}
        />
      </SettingRow>
    </SettingsSection>
  );
}
