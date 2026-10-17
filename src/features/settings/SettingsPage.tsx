import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { RefreshCw, SlidersHorizontal } from "lucide-react";
import { ZOOM_LEVELS, useLayout } from "@/app/layout/layoutStore";
import { Button, IconButton } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { useOutputDevices } from "@/features/output/useOutputDevices";
import type { LoudnessTarget, NormalizationMode } from "@/player/engineTypes";
import { supportedLanguages, type Language } from "@/i18n";
import { useLanguage } from "@/settings/language";
import { useSettings, type AccentColor, type QualityPreset } from "@/settings/store";
import { StorageSettings } from "@/features/downloads/StorageSettings";
import { AboutSection } from "@/features/updates/AboutSection";
import { Segmented, SettingRow, SettingsSection, type SegmentedOption } from "./controls";
import { RangeSlider } from "./RangeSlider";

/** Choices for “continue where you left off”, in minutes (0 = off). */
const RESUME_WINDOWS = [0, 5, 10, 30];

const QUALITIES: readonly QualityPreset[] = ["original", "high", "normal", "low"];
const NORMALIZATION_MODES: readonly NormalizationMode[] = ["off", "track", "album", "auto"];
const TARGETS: readonly LoudnessTarget[] = ["loud", "normal", "quiet"];

const SWATCH: Record<AccentColor, string> = {
  purple: "bg-violet-500",
  blue: "bg-blue-500",
  red: "bg-rose-600",
  dynamic: "bg-gradient-to-br from-violet-500 via-blue-500 to-rose-500",
};

function Swatch({ accent }: { accent: AccentColor }) {
  return <span aria-hidden="true" className={`size-3.5 rounded-full ${SWATCH[accent]}`} />;
}

function AudioQualitySection() {
  const { t } = useTranslation();
  const streaming = useSettings((s) => s.streamingQuality);
  const download = useSettings((s) => s.downloadQuality);
  const set = useSettings((s) => s.set);
  const options: SegmentedOption<QualityPreset>[] = QUALITIES.map((q) => ({
    value: q,
    label: t(`settings.quality.options.${q}`),
  }));

  return (
    <SettingsSection
      id="settings-quality"
      title={t("settings.quality.title")}
      description={t("settings.quality.description")}
    >
      <SettingRow
        stacked
        title={t("settings.quality.streaming")}
        description={t(`settings.quality.hints.${streaming}`)}
      >
        <Segmented
          label={t("settings.quality.streaming")}
          value={streaming}
          options={options}
          onChange={(v) => set("streamingQuality", v)}
        />
      </SettingRow>
      <SettingRow
        stacked
        title={t("settings.quality.downloads")}
        description={t(`settings.quality.hints.${download}`)}
      >
        <Segmented
          label={t("settings.quality.downloads")}
          value={download}
          options={options}
          onChange={(v) => set("downloadQuality", v)}
        />
      </SettingRow>
    </SettingsSection>
  );
}

function PlaybackSection() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const crossfade = useSettings((s) => s.crossfade);
  const normalization = useSettings((s) => s.normalization);
  const stereo = useSettings((s) => s.dsp.stereo);
  const set = useSettings((s) => s.set);
  const updateDsp = useSettings((s) => s.updateDsp);
  const seconds = Math.round(crossfade.durationMs / 1000);
  const normalizationOff = normalization.mode === "off";

  const resumeWindowMin = useSettings((s) => s.resumeWindowMin);
  const syncPlayQueue = useSettings((s) => s.syncPlayQueue);
  const setStereo = (patch: Partial<typeof stereo>) =>
    updateDsp((dsp) => ({ ...dsp, stereo: { ...dsp.stereo, ...patch } }));

  return (
    <SettingsSection
      id="settings-playback"
      title={t("settings.playback.title")}
      description={t("settings.playback.description")}
    >
      <SettingRow
        stacked
        title={t("settings.playback.crossfade")}
        description={t("settings.playback.crossfadeHint")}
      >
        <RangeSlider
          label={t("settings.playback.crossfade")}
          value={seconds}
          min={0}
          max={12}
          step={1}
          defaultValue={0}
          format={(v) => (v === 0 ? t("settings.off") : `${v} s`)}
          onChange={(v) => set("crossfade", { ...crossfade, durationMs: v * 1000 })}
        />
      </SettingRow>
      <SettingRow
        title={t("settings.playback.skipSameAlbum")}
        description={t("settings.playback.skipSameAlbumHint")}
        disabledReason={seconds === 0 ? t("settings.playback.needsCrossfade") : undefined}
      >
        <Switch
          checked={crossfade.skipSameAlbum}
          disabled={seconds === 0}
          onCheckedChange={(skipSameAlbum) => set("crossfade", { ...crossfade, skipSameAlbum })}
          label={t("settings.playback.skipSameAlbum")}
        />
      </SettingRow>
      <SettingRow
        stacked
        title={t("settings.playback.resume")}
        description={t("settings.playback.resumeHint")}
      >
        <Segmented
          label={t("settings.playback.resume")}
          value={resumeWindowMin}
          options={RESUME_WINDOWS.map((m) => ({
            value: m,
            label: m === 0 ? t("settings.off") : t("settings.playback.resumeMinutes", { count: m }),
          }))}
          onChange={(m) => set("resumeWindowMin", m)}
        />
      </SettingRow>
      <SettingRow title={t("settings.playback.syncQueue")} description={t("settings.playback.syncQueueHint")}>
        <Switch
          checked={syncPlayQueue}
          onCheckedChange={(on) => set("syncPlayQueue", on)}
          label={t("settings.playback.syncQueue")}
        />
      </SettingRow>
      <SettingRow title={t("settings.playback.gapless")} description={t("settings.playback.gaplessHint")}>
        <span className="text-sm font-bold text-subdued">{t("settings.alwaysOn")}</span>
      </SettingRow>

      <SettingRow
        stacked
        title={t("settings.playback.normalization")}
        description={t(`settings.playback.normalizationHints.${normalization.mode}`)}
      >
        <Segmented
          label={t("settings.playback.normalization")}
          value={normalization.mode}
          options={NORMALIZATION_MODES.map((m) => ({
            value: m,
            label: t(`settings.playback.normalizationModes.${m}`),
          }))}
          onChange={(mode) => set("normalization", { ...normalization, mode })}
        />
      </SettingRow>
      <SettingRow
        stacked
        title={t("settings.playback.target")}
        description={t("settings.playback.targetHint")}
        disabledReason={normalizationOff ? t("settings.playback.needsNormalization") : undefined}
      >
        <Segmented
          label={t("settings.playback.target")}
          value={normalization.target}
          disabled={normalizationOff}
          options={TARGETS.map((target) => ({
            value: target,
            label: t(`settings.playback.targets.${target}`),
          }))}
          onChange={(target) => set("normalization", { ...normalization, target })}
        />
      </SettingRow>
      <SettingRow
        title={t("settings.playback.preventClipping")}
        description={t("settings.playback.preventClippingHint")}
        disabledReason={normalizationOff ? t("settings.playback.needsNormalization") : undefined}
      >
        <Switch
          checked={normalization.preventClipping}
          disabled={normalizationOff}
          onCheckedChange={(preventClipping) => set("normalization", { ...normalization, preventClipping })}
          label={t("settings.playback.preventClipping")}
        />
      </SettingRow>
      <SettingRow
        title={t("settings.playback.analyzeUntagged")}
        description={t("settings.playback.analyzeUntaggedHint")}
        disabledReason={normalizationOff ? t("settings.playback.needsNormalization") : undefined}
      >
        <Switch
          checked={normalization.analyzeUntagged}
          disabled={normalizationOff}
          onCheckedChange={(analyzeUntagged) => set("normalization", { ...normalization, analyzeUntagged })}
          label={t("settings.playback.analyzeUntagged")}
        />
      </SettingRow>

      <SettingRow title={t("settings.playback.mono")} description={t("settings.playback.monoHint")}>
        <Switch
          checked={stereo.mono}
          onCheckedChange={(mono) => setStereo({ mono })}
          label={t("settings.playback.mono")}
        />
      </SettingRow>
      <SettingRow
        stacked
        title={t("settings.playback.balance")}
        description={t("settings.playback.balanceHint")}
      >
        <RangeSlider
          label={t("settings.playback.balance")}
          value={Math.round(stereo.balance * 100)}
          min={-100}
          max={100}
          step={1}
          defaultValue={0}
          format={(v) =>
            v === 0
              ? t("settings.playback.center")
              : t(v < 0 ? "settings.playback.left" : "settings.playback.right", { percent: Math.abs(v) })
          }
          onChange={(v) => setStereo({ balance: v / 100 })}
        />
      </SettingRow>
      <SettingRow
        stacked
        title={t("settings.playback.width")}
        description={t("settings.playback.widthHint")}
        disabledReason={stereo.mono ? t("settings.playback.needsStereo") : undefined}
      >
        <RangeSlider
          label={t("settings.playback.width")}
          value={Math.round(stereo.width * 100)}
          min={0}
          max={200}
          step={5}
          defaultValue={100}
          disabled={stereo.mono}
          format={(v) => `${v} %`}
          onChange={(v) => setStereo({ width: v / 100 })}
        />
      </SettingRow>

      <SettingRow title={t("settings.playback.equalizer")} description={t("settings.playback.equalizerHint")}>
        <Button
          variant="secondary"
          size="sm"
          icon={<SlidersHorizontal size={16} />}
          onClick={() => navigate("/equalizer")}
        >
          {t("settings.playback.openEqualizer")}
        </Button>
      </SettingRow>
    </SettingsSection>
  );
}

function OutputSection() {
  const { t } = useTranslation();
  const output = useSettings((s) => s.output);
  const set = useSettings((s) => s.set);
  const { devices, loading, refresh } = useOutputDevices();
  const selected = output.deviceId
    ? devices.find((d) => d.id === output.deviceId)
    : devices.find((d) => d.isDefault);
  const unsupported = !!selected && !selected.supportsExclusive;

  return (
    <SettingsSection
      id="settings-output"
      title={t("settings.output.title")}
      description={t("settings.output.description")}
    >
      <SettingRow title={t("settings.output.device")} description={t("settings.output.deviceHint")}>
        <div className="flex items-center gap-2">
          <select
            aria-label={t("settings.output.device")}
            value={output.deviceId ?? ""}
            onChange={(e) => set("output", { ...output, deviceId: e.target.value || null })}
            className="h-10 w-full min-w-48 rounded-md border border-muted bg-surface px-3 text-sm text-text outline-none hover:border-subdued focus:border-text"
          >
            <option value="">{t("devices.systemDefault")}</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
            {output.deviceId && !devices.some((d) => d.id === output.deviceId) && (
              <option value={output.deviceId}>{t("settings.output.unavailable")}</option>
            )}
          </select>
          <IconButton label={t("output.refresh")} onClick={refresh} disabled={loading}>
            <RefreshCw size={16} className={loading ? "animate-spin" : undefined} />
          </IconButton>
        </div>
      </SettingRow>
      <SettingRow
        title={t("settings.output.exclusive")}
        description={unsupported ? t("output.exclusiveUnsupported") : t("settings.output.exclusiveHint")}
      >
        <Switch
          checked={output.exclusive}
          disabled={unsupported}
          onCheckedChange={(exclusive) => set("output", { ...output, exclusive })}
          label={t("settings.output.exclusive")}
        />
      </SettingRow>
    </SettingsSection>
  );
}

function DisplaySection() {
  const { t, i18n } = useTranslation();
  const accent = useSettings((s) => s.accent);
  const set = useSettings((s) => s.set);
  const zoom = useLayout((s) => s.zoom);
  const setZoom = useLayout((s) => s.setZoom);
  const setLanguage = useLanguage((s) => s.setLanguage);
  const language: Language = i18n.language.toLowerCase().startsWith("de") ? "de" : "en";

  const accents: AccentColor[] = ["purple", "blue", "red", "dynamic"];
  const zoomValue = ZOOM_LEVELS.find((z) => Math.abs(z - zoom) < 0.001) ?? 1;

  return (
    <SettingsSection
      id="settings-display"
      title={t("settings.display.title")}
      description={t("settings.display.description")}
    >
      <SettingRow
        stacked
        title={t("settings.display.accent")}
        description={
          accent === "dynamic" ? t("settings.display.accentDynamicHint") : t("settings.display.accentHint")
        }
      >
        <Segmented
          label={t("settings.display.accent")}
          value={accent}
          options={accents.map((a) => ({
            value: a,
            label: t(`settings.display.accents.${a}`),
            icon: <Swatch accent={a} />,
          }))}
          onChange={(a) => set("accent", a)}
        />
      </SettingRow>
      <SettingRow stacked title={t("settings.display.zoom")} description={t("settings.display.zoomHint")}>
        <Segmented
          label={t("settings.display.zoom")}
          value={zoomValue}
          options={ZOOM_LEVELS.map((z) => ({ value: z, label: `${Math.round(z * 100)} %` }))}
          onChange={setZoom}
        />
      </SettingRow>
      <SettingRow stacked title={t("settings.display.language")}>
        <Segmented
          label={t("settings.display.language")}
          value={language}
          options={supportedLanguages.map((l) => ({ value: l, label: t(`settings.display.languages.${l}`) }))}
          onChange={setLanguage}
        />
      </SettingRow>
    </SettingsSection>
  );
}

export function SettingsPage() {
  const { t } = useTranslation();
  return (
    <div className="max-w-3xl px-6 pb-10">
      <h1 className="pt-6 pb-4 text-3xl font-bold tracking-tight">{t("settings.title")}</h1>
      <div className="flex flex-col gap-5">
        <AudioQualitySection />
        <PlaybackSection />
        <OutputSection />
        <div className="rounded-lg bg-elevated px-6">
          <StorageSettings />
        </div>
        <DisplaySection />
        <AboutSection />
      </div>
    </div>
  );
}
