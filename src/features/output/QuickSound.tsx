import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Switch } from "@/components/ui/Switch";
import { applyPreset, setEqEnabled, updateBass } from "@/features/equalizer/eqActions";
import { BUILT_IN_PRESETS } from "@/features/equalizer/presets";
import { Segmented } from "@/features/settings/controls";
import { RangeSlider } from "@/features/settings/RangeSlider";
import type { NormalizationMode } from "@/player/engineTypes";
import { useSettings } from "@/settings/store";

const NORMALIZATION_MODES: readonly NormalizationMode[] = ["off", "track", "album", "auto"];

function ToggleRow({
  title,
  checked,
  onChange,
}: {
  title: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="text-sm font-bold">{title}</p>
      <Switch checked={checked} onCheckedChange={onChange} label={title} />
    </div>
  );
}

/** The sound settings people change most, right next to the format (audio panel). */
export function QuickSound() {
  const { t } = useTranslation();
  const eqEnabled = useSettings((s) => s.dsp.eq.enabled);
  const bassEnabled = useSettings((s) => s.dsp.bass.enabled);
  const presetId = useSettings((s) => s.eqPresetId);
  const customPresets = useSettings((s) => s.customPresets);
  const normalization = useSettings((s) => s.normalization);
  const crossfade = useSettings((s) => s.crossfade);
  const set = useSettings((s) => s.set);
  const known = presetId !== null && (BUILT_IN_PRESETS.some((p) => p.id === presetId) || customPresets.some((p) => p.id === presetId));

  return (
    <section aria-label={t("output.sound")} className="flex flex-col gap-4 rounded-lg bg-elevated p-4">
      <h3 className="font-bold">{t("output.sound")}</h3>

      <div className="flex flex-col gap-2">
        <ToggleRow title={t("output.stages.equalizer")} checked={eqEnabled} onChange={setEqEnabled} />
        <select
          aria-label={t("output.eqPreset")}
          value={known ? presetId : ""}
          onChange={(e) => e.target.value && applyPreset(e.target.value)}
          className="h-9 w-full cursor-pointer rounded-md bg-highlight px-3 text-sm text-text outline-none hover:bg-press focus-visible:ring-2 focus-visible:ring-accent"
        >
          {!known && <option value="">{t("output.ownSetting")}</option>}
          <optgroup label={t("output.builtInPresets")}>
            {BUILT_IN_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {t(`equalizer.presetNames.${p.id}`)}
              </option>
            ))}
          </optgroup>
          {customPresets.length > 0 && (
            <optgroup label={t("output.myPresets")}>
              {customPresets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>

      <ToggleRow
        title={t("output.stages.bass")}
        checked={bassEnabled}
        onChange={(enabled) => updateBass({ enabled })}
      />

      <div className="flex flex-col gap-2">
        <p className="text-sm font-bold">{t("settings.playback.normalization")}</p>
        <Segmented
          label={t("settings.playback.normalization")}
          value={normalization.mode}
          options={NORMALIZATION_MODES.map((m) => ({ value: m, label: t(`settings.playback.normalizationModes.${m}`) }))}
          onChange={(mode) => set("normalization", { ...normalization, mode })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-sm font-bold">{t("settings.playback.crossfade")}</p>
        <RangeSlider
          label={t("settings.playback.crossfade")}
          value={Math.round(crossfade.durationMs / 1000)}
          min={0}
          max={12}
          step={1}
          defaultValue={0}
          format={(v) => (v === 0 ? t("output.off") : `${v} s`)}
          onChange={(v) => set("crossfade", { ...crossfade, durationMs: v * 1000 })}
        />
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <Link to="/equalizer" className="text-sm font-bold text-subdued hover:text-text hover:underline">
          {t("output.openEqualizer")}
        </Link>
        <Link to="/settings" className="text-sm font-bold text-subdued hover:text-text hover:underline">
          {t("output.allSettings")}
        </Link>
      </div>
    </section>
  );
}
