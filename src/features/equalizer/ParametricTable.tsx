import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import { Button, IconButton } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/cn";
import type { FilterKind, ParametricFilter } from "@/player/engineTypes";
import { hasGain, MAX_PARAMETRIC_FILTERS } from "./eqMath";
import { NumberField } from "./NumberField";

const KINDS: readonly FilterKind[] = ["peaking", "lowShelf", "highShelf", "lowPass", "highPass", "notch"];

export interface ParametricTableProps {
  filters: readonly ParametricFilter[];
  selected: number | null;
  onSelect: (index: number | null) => void;
  onChange: (index: number, patch: Partial<ParametricFilter>) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
}

/** Filter list with numeric inputs (the curve points and this table edit the same filters). */
export function ParametricTable({ filters, selected, onSelect, onChange, onAdd, onRemove }: ParametricTableProps) {
  const { t } = useTranslation();
  const full = filters.length >= MAX_PARAMETRIC_FILTERS;

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-separate border-spacing-y-1 text-sm">
          <thead>
            <tr className="text-left text-xs text-subdued">
              <th className="w-10 px-2 font-normal">#</th>
              <th className="w-16 px-2 font-normal">{t("equalizer.parametric.active")}</th>
              <th className="px-2 font-normal">{t("equalizer.parametric.type")}</th>
              <th className="w-28 px-2 text-right font-normal">{t("equalizer.parametric.frequency")}</th>
              <th className="w-24 px-2 text-right font-normal">{t("equalizer.parametric.gain")}</th>
              <th className="w-20 px-2 text-right font-normal">Q</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {filters.map((filter, index) => {
              const n = index + 1;
              const isSelected = selected === index;
              return (
                <tr
                  // The list has no stable ids; rows are identified by position like the engine's filters.
                  key={index}
                  data-selected={isSelected}
                  onFocusCapture={() => onSelect(index)}
                  onClick={() => onSelect(index)}
                  className={cn(
                    "rounded-md bg-surface [&>td]:py-1.5",
                    isSelected && "outline-2 -outline-offset-2 outline-accent",
                    !filter.enabled && "text-subdued",
                  )}
                >
                  <td className="rounded-l-md px-2 font-bold tabular-nums">{n}</td>
                  <td className="px-2">
                    <Switch
                      checked={filter.enabled}
                      onCheckedChange={(enabled) => onChange(index, { enabled })}
                      label={t("equalizer.parametric.activeLabel", { n })}
                    />
                  </td>
                  <td className="px-2">
                    <select
                      aria-label={t("equalizer.parametric.typeLabel", { n })}
                      value={filter.kind}
                      onChange={(e) => onChange(index, { kind: e.target.value as FilterKind })}
                      className="h-8 w-full rounded-md border border-muted bg-surface px-2 text-sm text-text outline-none hover:border-subdued focus:border-text"
                    >
                      {KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {t(`equalizer.filterTypes.${kind}`)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2">
                    <NumberField
                      label={t("equalizer.parametric.frequencyLabel", { n })}
                      value={filter.freqHz}
                      min={20}
                      max={20_000}
                      step={1}
                      digits={1}
                      onCommit={(freqHz) => onChange(index, { freqHz })}
                    />
                  </td>
                  <td className="px-2">
                    <NumberField
                      label={t("equalizer.parametric.gainLabel", { n })}
                      value={filter.gainDb}
                      min={-24}
                      max={24}
                      step={0.5}
                      digits={1}
                      disabled={!hasGain(filter.kind)}
                      onCommit={(gainDb) => onChange(index, { gainDb })}
                    />
                  </td>
                  <td className="px-2">
                    <NumberField
                      label={t("equalizer.parametric.qLabel", { n })}
                      value={filter.q}
                      min={0.1}
                      max={50}
                      step={0.1}
                      digits={2}
                      onCommit={(q) => onChange(index, { q })}
                    />
                  </td>
                  <td className="rounded-r-md pr-2">
                    <IconButton
                      label={t("equalizer.parametric.remove", { n })}
                      size={28}
                      onClick={() => onRemove(index)}
                    >
                      <Trash2 size={16} />
                    </IconButton>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {filters.length === 0 && <p className="px-2 py-3 text-sm text-subdued">{t("equalizer.parametric.empty")}</p>}
      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" variant="secondary" icon={<Plus size={16} />} onClick={onAdd} disabled={full}>
          {t("equalizer.parametric.add")}
        </Button>
        <span className="text-[13px] text-subdued tabular-nums">
          {t("equalizer.parametric.count", { count: filters.length, max: MAX_PARAMETRIC_FILTERS })}
        </span>
      </div>
    </div>
  );
}
