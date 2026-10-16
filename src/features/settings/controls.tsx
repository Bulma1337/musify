import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: string;
  /** Small element in front of the label (e.g. a color swatch). */
  icon?: ReactNode;
}

export interface SegmentedProps<T extends string | number> {
  label: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
}

/** Radio group drawn as a row of pills; arrow keys move the selection (roving tabindex). */
export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled,
}: SegmentedProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const index = options.findIndex((o) => o.value === value);
    const next = options[(index + step + options.length) % options.length];
    if (!next) return;
    onChange(next.value);
    refs.current[options.indexOf(next)]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      onKeyDown={disabled ? undefined : onKeyDown}
      className={cn("flex flex-wrap gap-1.5", disabled && "pointer-events-none opacity-50")}
    >
      {options.map((option, i) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex h-9 items-center gap-2 rounded-full px-4 text-sm font-bold transition-colors",
              selected ? "bg-text text-black" : "bg-surface text-subdued hover:text-text",
            )}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** One setting: title and explanation on the left, the control on the right (or below when `stacked`). */
export function SettingRow({
  title,
  description,
  children,
  stacked,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  stacked?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex gap-x-6 gap-y-3 py-4",
        stacked ? "flex-col" : "flex-col sm:flex-row sm:items-center sm:justify-between",
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="font-bold">{title}</p>
        {description && <p className="mt-0.5 max-w-prose text-[13px] text-subdued">{description}</p>}
      </div>
      <div className={cn(!stacked && "sm:max-w-[60%] sm:shrink-0", stacked && "w-full max-w-md")}>
        {children}
      </div>
    </div>
  );
}

export function SettingsSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="rounded-lg bg-elevated px-6 pt-5 pb-2">
      <h2 id={id} className="text-2xl font-bold tracking-tight">
        {title}
      </h2>
      {description && <p className="mt-1 max-w-prose text-sm text-subdued">{description}</p>}
      <div className="mt-2 divide-y divide-divider">{children}</div>
    </section>
  );
}
