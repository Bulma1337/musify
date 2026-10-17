import { useState } from "react";
import { useTranslation } from "react-i18next";
import { DropdownMenu } from "radix-ui";
import { Check, ChevronDown, FileUp, Pencil, Save, SaveAll, Share2, Trash2 } from "lucide-react";
import { IconButton } from "@/components/ui/Button";
import { menuContent, menuItem, menuSeparator } from "@/components/media/TrackMenu";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { useSettings } from "@/settings/store";
import {
  addCustomPresets,
  applyImportedEq,
  applyPreset,
  deletePreset,
  isPresetModified,
  overwritePreset,
  renamePreset,
  saveCurrentAsPreset,
  snapshotDsp,
} from "./eqActions";
import { AutoEqDialog, ConfirmDialog, NameDialog, ShareDialog } from "./PresetDialogs";
import { BUILT_IN_PRESETS, getBuiltInPreset } from "./presets";

const presetItem = cn(menuItem, "h-9");
const groupLabel = "px-3 py-2 text-xs font-bold text-subdued";

type Dialog = "saveAs" | "rename" | "delete" | "share" | "autoEq" | null;

/** Preset dropdown with save / rename / delete / share / AutoEQ import. */
export function PresetBar() {
  const { t } = useTranslation();
  const presetId = useSettings((s) => s.eqPresetId);
  const customPresets = useSettings((s) => s.customPresets);
  const dsp = useSettings((s) => s.dsp);
  const [dialog, setDialog] = useState<Dialog>(null);

  const custom = customPresets.find((p) => p.id === presetId);
  const builtIn = getBuiltInPreset(presetId);
  const modified = custom ? isPresetModified(custom, dsp) : false;
  const currentName =
    custom?.name ?? (builtIn ? t(`equalizer.presetNames.${builtIn.id}`) : t("equalizer.presets.customCurve"));
  const selectValue = custom || builtIn ? (presetId ?? "") : "";

  const triggerLabel =
    custom && modified ? `${currentName} (${t("equalizer.presets.modified")})` : currentName;

  const close = (open: boolean) => {
    if (!open) setDialog(null);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          aria-label={t("equalizer.presets.label")}
          title={t("equalizer.presets.label")}
          className="flex h-10 min-w-0 max-w-64 flex-1 basis-44 items-center justify-between gap-2 rounded-md border border-muted bg-surface px-3 text-sm text-text outline-none hover:border-subdued focus-visible:border-text data-[state=open]:border-text"
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronDown size={16} className="shrink-0 text-subdued" aria-hidden="true" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            sideOffset={4}
            className={cn(
              menuContent,
              "max-h-[min(26rem,var(--radix-dropdown-menu-content-available-height))] min-w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto",
            )}
          >
            <DropdownMenu.RadioGroup value={selectValue} onValueChange={(id) => id && applyPreset(id)}>
              {selectValue === "" && (
                <DropdownMenu.RadioItem value="" disabled className={presetItem}>
                  <span className="flex-1 truncate">{t("equalizer.presets.customCurve")}</span>
                  <DropdownMenu.ItemIndicator>
                    <Check size={16} className="text-accent" />
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.RadioItem>
              )}
              {customPresets.length > 0 && (
                <DropdownMenu.Group>
                  <DropdownMenu.Label className={groupLabel}>
                    {t("equalizer.presets.mine")}
                  </DropdownMenu.Label>
                  {customPresets.map((p) => (
                    <DropdownMenu.RadioItem key={p.id} value={p.id} className={presetItem}>
                      <span className="flex-1 truncate">
                        {p.id === presetId && modified
                          ? `${p.name} (${t("equalizer.presets.modified")})`
                          : p.name}
                      </span>
                      <DropdownMenu.ItemIndicator>
                        <Check size={16} className="text-accent" />
                      </DropdownMenu.ItemIndicator>
                    </DropdownMenu.RadioItem>
                  ))}
                </DropdownMenu.Group>
              )}
              {customPresets.length > 0 && <DropdownMenu.Separator className={menuSeparator} />}
              <DropdownMenu.Group>
                <DropdownMenu.Label className={groupLabel}>
                  {t("equalizer.presets.builtIn")}
                </DropdownMenu.Label>
                {BUILT_IN_PRESETS.map((p) => (
                  <DropdownMenu.RadioItem key={p.id} value={p.id} className={presetItem}>
                    <span className="flex-1 truncate">{t(`equalizer.presetNames.${p.id}`)}</span>
                    <DropdownMenu.ItemIndicator>
                      <Check size={16} className="text-accent" />
                    </DropdownMenu.ItemIndicator>
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.Group>
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <div className="flex items-center gap-2">
        {custom && modified && (
          <IconButton
            label={t("equalizer.presets.update")}
            onClick={() => {
              overwritePreset(custom.id);
              toast(t("equalizer.presets.updated", { name: custom.name }));
            }}
          >
            <Save size={18} />
          </IconButton>
        )}
        <IconButton label={t("equalizer.presets.saveAs")} onClick={() => setDialog("saveAs")}>
          <SaveAll size={18} />
        </IconButton>
        {custom && (
          <>
            <IconButton label={t("equalizer.presets.rename")} onClick={() => setDialog("rename")}>
              <Pencil size={18} />
            </IconButton>
            <IconButton label={t("equalizer.presets.delete")} onClick={() => setDialog("delete")}>
              <Trash2 size={18} />
            </IconButton>
          </>
        )}
        <IconButton label={t("equalizer.share.title")} onClick={() => setDialog("share")}>
          <Share2 size={18} />
        </IconButton>
        <IconButton label={t("equalizer.autoEq.title")} onClick={() => setDialog("autoEq")}>
          <FileUp size={18} />
        </IconButton>
      </div>

      <NameDialog
        open={dialog === "saveAs"}
        onOpenChange={close}
        title={t("equalizer.presets.saveAs")}
        initial={custom ? `${custom.name} 2` : builtIn ? currentName : ""}
        confirmLabel={t("equalizer.presets.save")}
        onSubmit={(name) => {
          saveCurrentAsPreset(name);
          toast(t("equalizer.presets.saved", { name }));
        }}
      />
      <NameDialog
        open={dialog === "rename" && !!custom}
        onOpenChange={close}
        title={t("equalizer.presets.rename")}
        initial={custom?.name ?? ""}
        confirmLabel={t("equalizer.presets.renameConfirm")}
        onSubmit={(name) => custom && renamePreset(custom.id, name)}
      />
      <ConfirmDialog
        open={dialog === "delete" && !!custom}
        onOpenChange={close}
        title={t("equalizer.presets.deleteTitle", { name: custom?.name ?? "" })}
        description={t("equalizer.presets.deleteHint")}
        confirmLabel={t("equalizer.presets.delete")}
        onConfirm={() => custom && deletePreset(custom.id)}
      />
      <ShareDialog
        open={dialog === "share"}
        onOpenChange={close}
        name={custom?.name ?? (builtIn ? currentName : "")}
        dsp={snapshotDsp(dsp)}
        onImport={addCustomPresets}
      />
      <AutoEqDialog open={dialog === "autoEq"} onOpenChange={close} onImported={applyImportedEq} />
    </div>
  );
}
