import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { toast, toastError } from "@/components/ui/toast";
import { audioEngine } from "@/player/engine";
import type { EqConfig } from "@/player/engineTypes";
import type { PresetDsp } from "./eqActions";
import { Modal } from "./Modal";
import { parsePresets, serializePreset } from "./presetsIo";

const textareaClass =
  "h-56 w-full resize-none rounded-md border border-muted bg-surface p-3 font-mono text-[13px] text-text outline-none hover:border-subdued focus:border-text";

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function NameForm({
  initial,
  confirmLabel,
  onSubmit,
  onCancel,
}: {
  initial: string;
  confirmLabel: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial);
  function submit(e: FormEvent) {
    e.preventDefault();
    if (name.trim()) onSubmit(name.trim().slice(0, 60));
  }
  return (
    <form onSubmit={submit} className="mt-4 flex flex-col gap-4">
      <TextField
        label={t("equalizer.presets.name")}
        value={name}
        maxLength={60}
        onChange={(e) => setName(e.target.value)}
        autoFocus
      />
      <div className="mt-2 flex justify-end gap-3">
        <Button variant="ghost" onClick={onCancel}>
          {t("equalizer.cancel")}
        </Button>
        <Button type="submit" disabled={!name.trim()}>
          {confirmLabel}
        </Button>
      </div>
    </form>
  );
}

/** Name prompt for "save as" and "rename". The form remounts on every open. */
export function NameDialog({
  open,
  onOpenChange,
  title,
  initial,
  confirmLabel,
  onSubmit,
}: DialogProps & { title: string; initial: string; confirmLabel: string; onSubmit: (name: string) => void }) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title}>
      <NameForm
        initial={initial}
        confirmLabel={confirmLabel}
        onSubmit={(name) => {
          onSubmit(name);
          onOpenChange(false);
        }}
        onCancel={() => onOpenChange(false)}
      />
    </Modal>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
}: DialogProps & { title: string; description: string; confirmLabel: string; onConfirm: () => void }) {
  const { t } = useTranslation();
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title} description={description}>
      <div className="mt-6 flex justify-end gap-3">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          {t("equalizer.cancel")}
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            onConfirm();
            onOpenChange(false);
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

function ShareForm({
  name,
  dsp,
  onImport,
  onClose,
}: {
  name: string;
  dsp: PresetDsp;
  onImport: (items: { name: string; dsp: PresetDsp }[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(() => serializePreset(name, dsp));
  const [error, setError] = useState<string | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      toast(t("equalizer.share.copied"));
    } catch {
      toastError(t("equalizer.share.copyFailed"));
    }
  }

  function importText() {
    try {
      const items = parsePresets(text).map((p) => ({
        name: p.name || t("equalizer.share.importedName"),
        dsp: p.dsp,
      }));
      onImport(items);
      toast(t("equalizer.share.imported", { count: items.length }));
      onClose();
    } catch {
      setError(t("equalizer.share.invalid"));
    }
  }

  return (
    <div className="mt-4 flex flex-col gap-3">
      <textarea
        aria-label={t("equalizer.share.textLabel")}
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        onFocus={(e) => e.currentTarget.select()}
        className={textareaClass}
      />
      {error && (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}
      <div className="mt-2 flex justify-end gap-3">
        <Button variant="ghost" onClick={onClose}>
          {t("equalizer.close")}
        </Button>
        <Button variant="secondary" onClick={() => void copy()}>
          {t("equalizer.share.copy")}
        </Button>
        <Button onClick={importText} disabled={!text.trim()}>
          {t("equalizer.share.import")}
        </Button>
      </div>
    </div>
  );
}

/** Export (copy) and import (paste) of presets as JSON text. */
export function ShareDialog({
  open,
  onOpenChange,
  name,
  dsp,
  onImport,
}: DialogProps & {
  name: string;
  dsp: PresetDsp;
  onImport: (items: { name: string; dsp: PresetDsp }[]) => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t("equalizer.share.title")}
      description={t("equalizer.share.description")}
      wide
    >
      <ShareForm name={name} dsp={dsp} onImport={onImport} onClose={() => onOpenChange(false)} />
    </Modal>
  );
}

function AutoEqForm({ onImported, onClose }: { onImported: (eq: EqConfig) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function pickFile(file: File | undefined) {
    if (!file) return;
    try {
      setText(await file.text());
      setError(null);
    } catch {
      setError(t("equalizer.autoEq.readFailed"));
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const config = await audioEngine().parseAutoEq(text);
      onImported(config);
      toast(t("equalizer.autoEq.imported"));
      onClose();
    } catch (err) {
      setError(t("equalizer.autoEq.failed", { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-4 flex flex-col gap-3">
      <textarea
        aria-label={t("equalizer.autoEq.textLabel")}
        value={text}
        spellCheck={false}
        placeholder={"Preamp: -6.2 dB\nFilter 1: ON PK Fc 105 Hz Gain -2.3 dB Q 0.70"}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        className={textareaClass}
      />
      <div className="flex items-center gap-3">
        <input
          ref={fileRef}
          type="file"
          accept=".txt,text/plain"
          aria-label={t("equalizer.autoEq.fileLabel")}
          className="sr-only"
          tabIndex={-1}
          onChange={(e) => {
            void pickFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <Button
          size="sm"
          variant="secondary"
          icon={<Upload size={16} />}
          onClick={() => fileRef.current?.click()}
        >
          {t("equalizer.autoEq.pickFile")}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}
      <div className="mt-2 flex justify-end gap-3">
        <Button variant="ghost" onClick={onClose}>
          {t("equalizer.cancel")}
        </Button>
        <Button type="submit" loading={busy} disabled={!text.trim()}>
          {t("equalizer.autoEq.import")}
        </Button>
      </div>
    </form>
  );
}

/** Imports an AutoEQ / Equalizer APO `ParametricEQ.txt` (pasted or from a file) via the engine's parser. */
export function AutoEqDialog({
  open,
  onOpenChange,
  onImported,
}: DialogProps & { onImported: (eq: EqConfig) => void }) {
  const { t } = useTranslation();
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t("equalizer.autoEq.title")}
      description={t("equalizer.autoEq.description")}
      wide
    >
      <AutoEqForm onImported={onImported} onClose={() => onOpenChange(false)} />
    </Modal>
  );
}
