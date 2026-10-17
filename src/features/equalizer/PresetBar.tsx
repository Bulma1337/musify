import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FileUp, Pencil, Save, SaveAll, Share2, Trash2 } from "lucide-react";
import { IconButton } from "@/components/ui/Button";
import { toast } from "@/components/ui/toast";
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

  const close = (open: boolean) => {
    if (!open) setDialog(null);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label={t("equalizer.presets.label")}
        value={selectValue}
        onChange={(e) => e.target.value && applyPreset(e.target.value)}
        className="h-10 min-w-56 rounded-md border border-muted bg-surface px-3 text-sm text-text outline-none hover:border-subdued focus:border-text"
      >
        <option value="" disabled={selectValue !== ""}>
          {t("equalizer.presets.customCurve")}
        </option>
        {customPresets.length > 0 && (
          <optgroup label={t("equalizer.presets.mine")}>
            {customPresets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id === presetId && modified ? `${p.name} (${t("equalizer.presets.modified")})` : p.name}
              </option>
            ))}
          </optgroup>
        )}
        <optgroup label={t("equalizer.presets.builtIn")}>
          {BUILT_IN_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {t(`equalizer.presetNames.${p.id}`)}
            </option>
          ))}
        </optgroup>
      </select>

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
