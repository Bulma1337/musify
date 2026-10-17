import { Slider } from "@/components/ui/Slider";
import { cn } from "@/lib/cn";

export interface RangeSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  /** Value step for keyboard and snapping. */
  step: number;
  onChange: (value: number) => void;
  /** Text for the value readout and for screen readers, e.g. "+2.5 dB". */
  format: (value: number) => string;
  /** Double-click resets to this value. */
  defaultValue?: number;
  disabled?: boolean;
  className?: string;
}

const snap = (value: number, step: number) => Number((Math.round(value / step) * step).toFixed(6));

/** Labelled slider with real units (the base `Slider` works on 0…1) and a value readout. */
export function RangeSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  defaultValue,
  disabled,
  className,
}: RangeSliderProps) {
  const span = max - min;
  return (
    <div
      inert={disabled}
      onDoubleClick={defaultValue === undefined ? undefined : () => onChange(defaultValue)}
      className={cn("flex items-center gap-3", disabled && "opacity-50", className)}
    >
      <Slider
        className="flex-1"
        label={label}
        value={(value - min) / span}
        step={step / span}
        valueText={format(value)}
        onChange={(v) => onChange(Math.min(max, Math.max(min, snap(min + v * span, step))))}
      />
      <output aria-hidden="true" className="w-20 shrink-0 text-right text-sm text-subdued tabular-nums">
        {format(value)}
      </output>
    </div>
  );
}
