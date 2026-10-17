import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import type { GraphicBands } from "@/player/engineTypes";
import { formatDb, formatFrequency, formatFrequencyShort } from "./curveGeometry";
import { GRAPHIC_FREQUENCIES, SLIDER_RANGE_DB } from "./eqMath";

const STEP_DB = 0.5;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const snap = (value: number) => Math.round(value / STEP_DB) * STEP_DB;

interface VerticalSliderProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  onActivity: () => void;
  compact: boolean;
  dimmed: boolean;
}

/** One band: vertical slider, ±12 dB in 0.5 dB steps, double-click resets, fully keyboard operable. */
function VerticalSlider({ label, value, onChange, onActivity, compact, dimmed }: VerticalSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  function valueAt(clientY: number): number {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.height === 0) return value;
    const ratio = clamp((clientY - rect.top) / rect.height, 0, 1);
    return clamp(snap(SLIDER_RANGE_DB - ratio * 2 * SLIDER_RANGE_DB), -SLIDER_RANGE_DB, SLIDER_RANGE_DB);
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    onActivity();
    onChange(valueAt(e.clientY));
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const big = e.shiftKey ? 4 : 1;
    let next: number;
    switch (e.key) {
      case "ArrowUp":
      case "ArrowRight":
        next = value + STEP_DB * big;
        break;
      case "ArrowDown":
      case "ArrowLeft":
        next = value - STEP_DB * big;
        break;
      case "PageUp":
        next = value + 3;
        break;
      case "PageDown":
        next = value - 3;
        break;
      case "Home":
        next = SLIDER_RANGE_DB;
        break;
      case "End":
        next = -SLIDER_RANGE_DB;
        break;
      case "0":
      case "Delete":
      case "Backspace":
        next = 0;
        break;
      default:
        return;
    }
    e.preventDefault();
    onChange(clamp(snap(next), -SLIDER_RANGE_DB, SLIDER_RANGE_DB));
  }

  // 0 dB sits in the middle of the track; the bar grows from there.
  const percent =
    ((clamp(value, -SLIDER_RANGE_DB, SLIDER_RANGE_DB) + SLIDER_RANGE_DB) / (2 * SLIDER_RANGE_DB)) * 100;
  const barBottom = Math.min(percent, 50);
  const barHeight = Math.abs(percent - 50);

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={-SLIDER_RANGE_DB}
      aria-valuemax={SLIDER_RANGE_DB}
      aria-valuenow={value}
      aria-valuetext={formatDb(value)}
      title={`${label}: ${formatDb(value)}`}
      onPointerDown={onPointerDown}
      onPointerMove={(e) => dragging && onChange(valueAt(e.clientY))}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onDoubleClick={() => onChange(0)}
      onKeyDown={onKeyDown}
      onFocus={onActivity}
      className={cn(
        "group relative flex h-48 touch-none justify-center rounded-md outline-none focus-visible:bg-highlight",
        compact ? "w-full min-w-3" : "w-full min-w-8",
        dimmed && "opacity-60",
      )}
    >
      <div ref={trackRef} className="relative h-full w-1 cursor-pointer rounded-full bg-white/20">
        <div className="absolute top-1/2 left-1/2 h-px w-3 -translate-x-1/2 bg-muted" />
        <div
          className="absolute inset-x-0 rounded-full bg-accent accent-fill"
          style={{ bottom: `${barBottom}%`, height: `${barHeight}%` }}
        />
        <div
          className={cn(
            "absolute left-1/2 size-3.5 -translate-x-1/2 translate-y-1/2 rounded-full bg-text shadow transition-transform group-hover:scale-110 group-focus-visible:scale-125",
            dragging && "scale-125",
          )}
          style={{ bottom: `${percent}%` }}
        />
      </div>
    </div>
  );
}

export interface GraphicSlidersProps {
  bands: GraphicBands;
  gainsDb: readonly number[];
  onChange: (index: number, gainDb: number) => void;
  enabled: boolean;
}

/** The band sliders of the 10- and 31-band modes with frequency labels. */
export function GraphicSliders({ bands, gainsDb, onChange, enabled }: GraphicSlidersProps) {
  const { t } = useTranslation();
  const freqs = GRAPHIC_FREQUENCIES[bands];
  const compact = bands === "thirtyOne";
  const [active, setActive] = useState(0);
  const activeFreq = freqs[active] ?? freqs[0] ?? 1000;

  return (
    <div>
      {compact && (
        <p className="mb-2 h-5 text-sm text-subdued tabular-nums" aria-hidden="true">
          {formatFrequency(activeFreq)}: <span className="text-text">{formatDb(gainsDb[active] ?? 0)}</span>
        </p>
      )}
      <div
        role="group"
        aria-label={t("equalizer.bands.groupLabel")}
        className={cn("flex items-start", compact ? "gap-0.5" : "gap-2")}
      >
        {freqs.map((freq, i) => (
          <div key={freq} className="flex min-w-0 flex-1 flex-col items-center gap-1">
            {!compact && (
              <span className="text-xs text-subdued tabular-nums" aria-hidden="true">
                {formatDb(gainsDb[i] ?? 0, 1).replace(" dB", "")}
              </span>
            )}
            <VerticalSlider
              label={formatFrequency(freq)}
              value={gainsDb[i] ?? 0}
              onChange={(v) => onChange(i, v)}
              onActivity={() => setActive(i)}
              compact={compact}
              dimmed={!enabled}
            />
            <span className={cn("text-subdued", compact ? "text-[10px]" : "text-xs")} aria-hidden="true">
              {formatFrequencyShort(freq)}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[13px] text-subdued">{t("equalizer.bands.hint")}</p>
    </div>
  );
}
