import { cn } from "@/lib/cn";

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  id?: string;
}

/** On/off toggle like the settings switches (accent when on). */
export function Switch({ checked, onCheckedChange, label, disabled, id }: SwitchProps) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative h-6 w-10 shrink-0 rounded-full transition-colors",
        // Disabled: grey, no hover, not-allowed cursor, so it never reads as "on".
        disabled
          ? "cursor-not-allowed bg-muted/50"
          : checked
            ? "bg-accent hover:bg-accent-hover"
            : "bg-muted hover:bg-subdued",
      )}
    >
      <span
        className={cn(
          "absolute top-1 left-1 size-4 rounded-full shadow transition-transform",
          disabled ? "bg-subdued" : "bg-text",
          checked && "translate-x-4",
        )}
      />
    </button>
  );
}
