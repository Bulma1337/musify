import type { ReactNode } from "react";
import { Dialog } from "radix-ui";

export interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}

/** Centered dialog in the app's style (same look as the playlist dialog). */
export function Modal({ open, onOpenChange, title, description, children, wide }: ModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          {...(description ? {} : { "aria-describedby": undefined })}
          className={`fixed top-1/2 left-1/2 z-50 max-h-[90vh] overflow-y-auto ${
            wide ? "w-[min(640px,calc(100vw-2rem))]" : "w-[min(480px,calc(100vw-2rem))]"
          } -translate-x-1/2 -translate-y-1/2 rounded-lg bg-elevated p-6 shadow-[0_16px_48px_rgb(0_0_0/0.5)] outline-none`}
        >
          <Dialog.Title className="text-2xl font-bold tracking-tight">{title}</Dialog.Title>
          {description && (
            <Dialog.Description className="mt-2 text-sm text-subdued">{description}</Dialog.Description>
          )}
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
