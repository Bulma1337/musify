import type { ReactNode } from "react";
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

/**
 * Row layout: one line per filter when the column is wide enough (container query), otherwise the
 * number fields wrap onto a second line with their own captions, so nothing is ever clipped.
 */
const ROW_GRID =
  "grid grid-cols-[1.25rem_2.5rem_minmax(0,1fr)_1.75rem] items-center gap-x-2 gap-y-1.5 @min-[26rem]:grid-cols-[1.25rem_2.5rem_minmax(5rem,1fr)_5rem_3.75rem_3.5rem_1.75rem]";

/** A number field with a caption that is only visible in the stacked (narrow) layout. */
function Labelled({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <span className="block min-w-0">
      <span aria-hidden="true" className="mb-0.5 block truncate text-[11px] text-subdued @min-[26rem]:hidden">
        {caption}
      </span>
      {children}
    </span>
  );
}

/** Filter list with numeric inputs (the curve points and this table edit the same filters). */
export function ParametricTable({
  filters,
  selected,
  onSelect,
  onChange,
  onAdd,
  onRemove,
}: ParametricTableProps) {
  const { t } = useTranslation();
  const full = filters.length >= MAX_PARAMETRIC_FILTERS;

  return (
    <div className="@container">
      <div role="table" aria-label={t("equalizer.modes.parametric")}>
        <div role="row" className={cn(ROW_GRID, "hidden px-2 text-xs text-subdued @min-[26rem]:grid")}>
          <span role="columnheader">#</span>
          <span role="columnheader">{t("equalizer.parametric.active")}</span>
          <span role="columnheader">{t("equalizer.parametric.type")}</span>
          <span role="columnheader" className="truncate text-right">
            {t("equalizer.parametric.frequencyShort")}
          </span>
          <span role="columnheader" className="truncate text-right">
            {t("equalizer.parametric.gainShort")}
          </span>
          <span role="columnheader" className="text-right">
            Q
          </span>
          <span role="columnheader" aria-hidden="true" />
        </div>
        <div role="rowgroup" className="flex flex-col gap-1">
          {filters.map((filter, index) => {
            const n = index + 1;
            const isSelected = selected === index;
            return (
              <div
                role="row"
                // The list has no stable ids; rows are identified by position like the engine's filters.
                key={index}
                data-selected={isSelected}
                onFocusCapture={() => onSelect(index)}
                onClick={() => onSelect(index)}
                className={cn(
                  ROW_GRID,
                  "rounded-md bg-surface px-2 py-1.5",
                  isSelected && "outline-2 -outline-offset-2 outline-accent",
                  !filter.enabled && "text-subdued",
                )}
              >
                <span role="cell" className="font-bold tabular-nums">
                  {n}
                </span>
                <span role="cell">
                  <Switch
                    checked={filter.enabled}
                    onCheckedChange={(enabled) => onChange(index, { enabled })}
                    label={t("equalizer.parametric.activeLabel", { n })}
                  />
                </span>
                <span role="cell" className="min-w-0">
                  <select
                    aria-label={t("equalizer.parametric.typeLabel", { n })}
                    value={filter.kind}
                    onChange={(e) => onChange(index, { kind: e.target.value as FilterKind })}
                    className="h-8 w-full min-w-0 rounded-md border border-muted bg-surface px-1.5 text-sm text-text outline-none hover:border-subdued focus:border-text"
                  >
                    {KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {t(`equalizer.filterTypes.${kind}`)}
                      </option>
                    ))}
                  </select>
                </span>
                <span role="cell" className="col-span-4 grid grid-cols-3 gap-2 @min-[26rem]:contents">
                  <Labelled caption={t("equalizer.parametric.frequencyShort")}>
                    <NumberField
                      label={t("equalizer.parametric.frequencyLabel", { n })}
                      value={filter.freqHz}
                      min={20}
                      max={20_000}
                      step={1}
                      digits={1}
                      onCommit={(freqHz) => onChange(index, { freqHz })}
                    />
                  </Labelled>
                  <Labelled caption={t("equalizer.parametric.gainShort")}>
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
                  </Labelled>
                  <Labelled caption="Q">
                    <NumberField
                      label={t("equalizer.parametric.qLabel", { n })}
                      value={filter.q}
                      min={0.1}
                      max={50}
                      step={0.1}
                      digits={2}
                      onCommit={(q) => onChange(index, { q })}
                    />
                  </Labelled>
                </span>
                <span
                  role="cell"
                  className="flex justify-end col-start-4 row-start-1 @min-[26rem]:col-auto @min-[26rem]:row-auto"
                >
                  <IconButton
                    label={t("equalizer.parametric.remove", { n })}
                    size={28}
                    onClick={() => onRemove(index)}
                  >
                    <Trash2 size={16} />
                  </IconButton>
                </span>
              </div>
            );
          })}
        </div>
      </div>
      {filters.length === 0 && (
        <p className="px-2 py-3 text-sm text-subdued">{t("equalizer.parametric.empty")}</p>
      )}
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
