import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

/** One choosable output in the audio panel (a sound device here or a speaker on the network). */
export function DeviceRow({
  selected,
  name,
  detail,
  icon,
  isDefault,
  busy,
  onSelect,
}: {
  selected: boolean;
  name: string;
  detail?: string;
  icon: (className: string) => ReactNode;
  isDefault?: boolean;
  /** Connecting: shows a spinner instead of the check. */
  busy?: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-busy={busy || undefined}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-3 rounded-md p-2 text-left hover:bg-highlight",
        selected && "bg-highlight",
      )}
    >
      {icon(cn("shrink-0", selected ? "text-accent" : "text-subdued"))}
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate", selected && "font-bold text-accent")}>{name}</span>
        {detail && <span className="block text-sm break-words text-subdued">{detail}</span>}
      </span>
      {isDefault && (
        <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 text-[11px] text-subdued">
          {t("output.default")}
        </span>
      )}
      {busy && <Loader2 size={18} className="shrink-0 animate-spin text-subdued" aria-hidden="true" />}
      {selected && !busy && <Check size={18} className="shrink-0 text-accent" aria-hidden="true" />}
    </button>
  );
}
