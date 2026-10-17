import { useState } from "react";
import { cn } from "@/lib/cn";

export interface NumberFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Decimal places shown when the field is not being edited. */
  digits?: number;
  disabled?: boolean;
  onCommit: (value: number) => void;
  className?: string;
}

/**
 * Numeric input that lets you type freely: valid values apply right away, the final value is clamped
 * when the field loses focus. While not edited it always shows the current value.
 */
export function NumberField({
  label,
  value,
  min,
  max,
  step,
  digits = 1,
  disabled,
  onCommit,
  className,
}: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(Number(value.toFixed(digits)));

  function parse(text: string): number | null {
    const v = Number(text.trim().replace(",", "."));
    return text.trim() !== "" && Number.isFinite(v) ? v : null;
  }

  return (
    <input
      type="number"
      inputMode="decimal"
      aria-label={label}
      value={shown}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onChange={(e) => {
        setDraft(e.target.value);
        const v = parse(e.target.value);
        if (v !== null && v >= min && v <= max) onCommit(v);
      }}
      onBlur={() => {
        if (draft !== null) {
          const v = parse(draft);
          if (v !== null) onCommit(Math.min(max, Math.max(min, v)));
        }
        setDraft(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
      className={cn(
        "h-8 w-full min-w-0 rounded-md border border-muted bg-surface px-2 text-right text-sm text-text tabular-nums outline-none",
        "hover:border-subdued focus:border-text disabled:opacity-40",
        className,
      )}
    />
  );
}
