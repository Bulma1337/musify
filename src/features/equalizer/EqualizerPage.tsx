import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { RangeSlider } from "@/features/settings/RangeSlider";
import { cn } from "@/lib/cn";
import { useSettings } from "@/settings/store";
import { formatDb } from "./curveGeometry";
import {
  addFilter,
  removeFilter,
  resetEq,
  setAutoHeadroom,
  setEqEnabled,
  setEqMode,
  setGraphicGain,
  setLimiter,
  setLoudnessCompensation,
  setPreamp,
  updateBass,
  updateFilter,
  type EqModeChoice,
} from "./eqActions";
import { EqCurve } from "./EqCurve";
import { MAX_PARAMETRIC_FILTERS } from "./eqMath";
import { GraphicSliders } from "./GraphicSliders";
import { ParametricTable } from "./ParametricTable";
import { PresetBar } from "./PresetBar";
import { useEqResponse } from "./useEqResponse";

function Card({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={cn("rounded-lg bg-elevated p-5", className)}>
      <h2 className="mb-3 font-bold">{title}</h2>
      {children}
    </section>
  );
}

function SwitchRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <Switch checked={checked} onCheckedChange={onChange} label={label} />
      <div className="min-w-0">
        <p className="text-sm font-bold">{label}</p>
        {hint && <p className="text-[13px] text-subdued">{hint}</p>}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-[13px] text-subdued">{label}</p>
      {children}
    </div>
  );
}

const MODES: readonly EqModeChoice[] = ["ten", "thirtyOne", "parametric"];

/**
 * A/B comparison: press to hear the signal without the EQ, hold = back on release, quick press =
 * stays bypassed until pressed again. The curve is never touched; only `eq.enabled` flips.
 */
function useBypass(enabled: boolean) {
  const [bypassed, setBypassed] = useState(false);
  const pressedAt = useRef<number | null>(null);
  const active = bypassed && !enabled;
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  });
  // Leaving the page must not leave the EQ switched off.
  useEffect(
    () => () => {
      if (activeRef.current) setEqEnabled(true);
    },
    [],
  );

  const begin = () => {
    setBypassed(true);
    setEqEnabled(false);
  };
  const end = () => {
    setBypassed(false);
    setEqEnabled(true);
  };

  return {
    active,
    clear: () => setBypassed(false),
    onPointerDown: () => {
      pressedAt.current = Date.now();
      if (active) end();
      else if (enabled) begin();
    },
    onPointerUp: () => {
      const held = pressedAt.current === null ? 0 : Date.now() - pressedAt.current;
      pressedAt.current = null;
      if (active && held > 400) end();
    },
    // Keyboard and assistive technology activate through click without a pointer press.
    onClick: (detail: number) => {
      if (detail !== 0) return;
      if (active) end();
      else if (enabled) begin();
    },
  };
}

export function EqualizerPage() {
  const { t } = useTranslation();
  const eq = useSettings((s) => s.dsp.eq);
  const bass = useSettings((s) => s.dsp.bass);
  const loudness = useSettings((s) => s.dsp.loudnessCompensation);
  const limiter = useSettings((s) => s.dsp.limiter);
  const [selected, setSelected] = useState<number | null>(null);
  const response = useEqResponse(eq);
  const bypass = useBypass(eq.enabled);

  const mode = eq.mode;
  const activeMode: EqModeChoice = mode.type === "parametric" ? "parametric" : mode.bands;
  const filterCount = mode.type === "parametric" ? mode.filters.length : 0;
  const selectedIndex = selected !== null && selected < filterCount ? selected : null;
  const processing = eq.enabled || bass.enabled || loudness;

  return (
    <div className="px-6 pb-10">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-3 pt-6 pb-4">
        <h1 className="text-3xl font-bold tracking-tight">{t("equalizer.title")}</h1>
        <Switch
          checked={eq.enabled || bypass.active}
          onCheckedChange={(on) => {
            bypass.clear();
            setEqEnabled(on);
          }}
          label={t("equalizer.power")}
        />
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant={bypass.active ? "primary" : "secondary"}
            aria-pressed={bypass.active}
            disabled={!eq.enabled && !bypass.active}
            title={t("equalizer.compareHint")}
            onPointerDown={bypass.onPointerDown}
            onPointerUp={bypass.onPointerUp}
            onClick={(e) => bypass.onClick(e.detail)}
          >
            {t("equalizer.compare")}
          </Button>
          <Button size="sm" variant="secondary" icon={<RotateCcw size={15} />} onClick={resetEq}>
            {t("equalizer.reset")}
          </Button>
        </div>
      </header>

      <PresetBar />

      {processing && (
        <p className="mt-3 text-[13px] text-subdued">{t("equalizer.notBitPerfect")}</p>
      )}

      <div role="tablist" aria-label={t("equalizer.modeLabel")} className="mt-5 mb-3 flex gap-1">
        {MODES.map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={activeMode === m}
            onClick={() => setEqMode(m)}
            className={cn(
              "h-9 rounded-full px-4 text-sm font-bold transition-colors",
              activeMode === m ? "bg-text text-black" : "bg-elevated text-subdued hover:text-text",
            )}
          >
            {t(`equalizer.modes.${m}`)}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-4">
        <section className="rounded-lg bg-elevated p-4" aria-label={t("equalizer.curve.title")}>
          <EqCurve
            eq={eq}
            response={response}
            selected={selectedIndex}
            onSelect={setSelected}
            onFilterChange={updateFilter}
            onFilterAdd={(filter) => {
              addFilter(filter);
              setSelected(filterCount);
            }}
          />
        </section>

        <section
          role="tabpanel"
          aria-label={t(`equalizer.modes.${activeMode}`)}
          className="rounded-lg bg-elevated p-5"
        >
          {mode.type === "graphic" ? (
            <GraphicSliders
              bands={mode.bands}
              gainsDb={mode.gainsDb}
              onChange={setGraphicGain}
              enabled={eq.enabled}
            />
          ) : (
            <ParametricTable
              filters={mode.filters}
              selected={selectedIndex}
              onSelect={setSelected}
              onChange={updateFilter}
              onAdd={() => {
                addFilter();
                setSelected(filterCount);
              }}
              onRemove={(index) => {
                removeFilter(index);
                setSelected(null);
              }}
            />
          )}
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card title={t("equalizer.preamp.title")}>
            <div className="flex flex-col gap-4">
              <Field label={t("equalizer.preamp.label")}>
                <RangeSlider
                  label={t("equalizer.preamp.label")}
                  value={eq.preampDb}
                  min={-20}
                  max={20}
                  step={0.5}
                  defaultValue={0}
                  format={(v) => formatDb(v)}
                  onChange={setPreamp}
                />
              </Field>
              <SwitchRow
                label={t("equalizer.preamp.auto")}
                hint={t("equalizer.preamp.autoHint")}
                checked={eq.autoHeadroom}
                onChange={setAutoHeadroom}
              />
              <p className="text-sm">
                <span className="text-subdued">{t("equalizer.preamp.effective")}: </span>
                <span className="font-bold tabular-nums" data-testid="effective-preamp">
                  {formatDb(eq.enabled ? response.effectivePreampDb : 0)}
                </span>
              </p>
              {mode.type === "parametric" && filterCount >= MAX_PARAMETRIC_FILTERS && (
                <p className="text-[13px] text-subdued">{t("equalizer.parametric.limitReached")}</p>
              )}
            </div>
          </Card>

          <Card title={t("equalizer.bass.title")}>
            <div className="flex flex-col gap-4">
              <SwitchRow
                label={t("equalizer.bass.enable")}
                hint={t("equalizer.bass.hint")}
                checked={bass.enabled}
                onChange={(enabled) => updateBass({ enabled })}
              />
              <Field label={t("equalizer.bass.boost")}>
                <RangeSlider
                  label={t("equalizer.bass.boost")}
                  value={bass.boostDb}
                  min={0}
                  max={12}
                  step={0.5}
                  defaultValue={6}
                  disabled={!bass.enabled}
                  format={(v) => formatDb(v)}
                  onChange={(boostDb) => updateBass({ boostDb })}
                />
              </Field>
              <Field label={t("equalizer.bass.frequency")}>
                <RangeSlider
                  label={t("equalizer.bass.frequency")}
                  value={bass.frequencyHz}
                  min={40}
                  max={150}
                  step={1}
                  defaultValue={80}
                  disabled={!bass.enabled}
                  format={(v) => `${Math.round(v)} Hz`}
                  onChange={(frequencyHz) => updateBass({ frequencyHz })}
                />
              </Field>
              <Field label={t("equalizer.bass.harmonics")}>
                <RangeSlider
                  label={t("equalizer.bass.harmonics")}
                  value={Math.round(bass.harmonics * 100)}
                  min={0}
                  max={100}
                  step={5}
                  defaultValue={30}
                  disabled={!bass.enabled}
                  format={(v) => `${Math.round(v)} %`}
                  onChange={(percent) => updateBass({ harmonics: percent / 100 })}
                />
              </Field>
            </div>
          </Card>
        </div>

        <Card title={t("equalizer.more.title")}>
          <div className="grid gap-5 md:grid-cols-2">
            <SwitchRow
              label={t("equalizer.more.loudness")}
              hint={t("equalizer.more.loudnessHint")}
              checked={loudness}
              onChange={setLoudnessCompensation}
            />
            <SwitchRow
              label={t("equalizer.more.limiter")}
              hint={t("equalizer.more.limiterHint")}
              checked={limiter}
              onChange={setLimiter}
            />
          </div>
        </Card>
      </div>
    </div>
  );
}
