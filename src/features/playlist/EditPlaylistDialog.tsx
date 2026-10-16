import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "radix-ui";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";

export const dialogOverlay = "fixed inset-0 z-50 bg-black/60";
export const dialogContent =
  "fixed top-1/2 left-1/2 z-50 w-[min(480px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-elevated p-6 shadow-[0_16px_48px_rgb(0_0_0/0.5)] outline-none";

export interface EditPlaylistDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: { name: string; comment: string };
  saving: boolean;
  onSave: (values: { name: string; comment: string }) => void;
}

function Form({
  initial,
  saving,
  onSave,
  onCancel,
}: Pick<EditPlaylistDialogProps, "initial" | "saving" | "onSave"> & { onCancel: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial.name);
  const [comment, setComment] = useState(initial.comment);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (name.trim()) onSave({ name: name.trim(), comment: comment.trim() });
  }

  return (
    <form onSubmit={submit} className="mt-4 flex flex-col gap-4">
      <TextField
        label={t("playlist.name")}
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
      />
      <TextField
        label={t("playlist.description")}
        value={comment}
        placeholder={t("playlist.descriptionPlaceholder")}
        onChange={(e) => setComment(e.target.value)}
      />
      <div className="mt-2 flex justify-end gap-3">
        <Button variant="ghost" onClick={onCancel}>
          {t("playlist.cancel")}
        </Button>
        <Button type="submit" loading={saving} disabled={!name.trim()}>
          {t("playlist.save")}
        </Button>
      </div>
    </form>
  );
}

/** Dialog with name and description fields for a playlist. The form remounts on every open. */
export function EditPlaylistDialog({ open, onOpenChange, initial, saving, onSave }: EditPlaylistDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlay} />
        <Dialog.Content className={dialogContent} aria-describedby={undefined}>
          <Dialog.Title className="text-2xl font-bold tracking-tight">{t("playlist.editTitle")}</Dialog.Title>
          <Form initial={initial} saving={saving} onSave={onSave} onCancel={() => onOpenChange(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
