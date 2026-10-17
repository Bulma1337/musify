import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp } from "lucide-react";
import { IconButton } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import {
  moveHomeSection,
  normalizeHomeSections,
  type AutoPlaylistPrefs,
  type HomeSectionId,
} from "@/settings/homeLayout";
import { useSettings } from "@/settings/store";
import { SettingRow, SettingsSection } from "./controls";

const AUTO_KINDS: (keyof Omit<AutoPlaylistPrefs, "enabled">)[] = ["heavyRotation", "rediscovered", "allTime", "topYear"];

/** Settings → Home: order and visibility of the rows, and which automatic playlists appear. */
export function HomeSettings() {
  const { t } = useTranslation();
  const saved = useSettings((s) => s.homeSections);
  const auto = useSettings((s) => s.autoPlaylists);
  const set = useSettings((s) => s.set);
  const sections = useMemo(() => normalizeHomeSections(saved), [saved]);
  const label = (id: HomeSectionId) =>
    id === "autoPlaylists" ? t("autoPlaylists.shelfTitle") : t(`home.${id}`);

  return (
    <SettingsSection id="settings-home" title={t("settings.home.title")} description={t("settings.home.description")}>
      <SettingRow stacked title={t("settings.home.rows")} description={t("settings.home.rowsHint")}>
        <ol className="flex flex-col gap-1" aria-label={t("settings.home.rows")}>
          {sections.map((section, index) => (
            <li key={section.id} className="flex items-center gap-2 rounded-md bg-highlight/60 py-1.5 pr-2 pl-3">
              <span className={section.visible ? "flex-1 text-sm" : "flex-1 text-sm text-subdued line-through"}>
                {label(section.id)}
              </span>
              <IconButton
                label={t("settings.home.moveUp", { name: label(section.id) })}
                disabled={index === 0}
                onClick={() => set("homeSections", moveHomeSection(sections, section.id, -1))}
              >
                <ChevronUp size={18} />
              </IconButton>
              <IconButton
                label={t("settings.home.moveDown", { name: label(section.id) })}
                disabled={index === sections.length - 1}
                onClick={() => set("homeSections", moveHomeSection(sections, section.id, 1))}
              >
                <ChevronDown size={18} />
              </IconButton>
              <Switch
                checked={section.visible}
                label={t("settings.home.show", { name: label(section.id) })}
                onCheckedChange={(visible) =>
                  set(
                    "homeSections",
                    sections.map((s) => (s.id === section.id ? { ...s, visible } : s)),
                  )
                }
              />
            </li>
          ))}
        </ol>
      </SettingRow>

      <SettingRow title={t("settings.home.autoPlaylists")} description={t("settings.home.autoPlaylistsHint")}>
        <Switch
          checked={auto.enabled}
          label={t("settings.home.autoPlaylists")}
          onCheckedChange={(enabled) => set("autoPlaylists", { ...auto, enabled })}
        />
      </SettingRow>
      {AUTO_KINDS.map((kind) => (
        <SettingRow
          key={kind}
          title={t(`settings.home.auto.${kind}`)}
          description={t(`settings.home.autoHints.${kind}`)}
          disabledReason={auto.enabled ? undefined : t("settings.home.needsAutoPlaylists")}
        >
          <Switch
            checked={auto.enabled && auto[kind]}
            disabled={!auto.enabled}
            label={t(`settings.home.auto.${kind}`)}
            onCheckedChange={(on) => set("autoPlaylists", { ...auto, [kind]: on })}
          />
        </SettingRow>
      ))}
    </SettingsSection>
  );
}
