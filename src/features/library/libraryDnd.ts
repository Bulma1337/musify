import type { DragEvent } from "react";

/** Drag type for moving a library entry (a playlist) onto a folder in the sidebar. */
export const LIBRARY_ENTRY_MIME = "application/x-musify-library-entry";

export function startEntryDrag(event: DragEvent, key: string): void {
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData(LIBRARY_ENTRY_MIME, key);
}

export function isEntryDrag(event: DragEvent): boolean {
  return event.dataTransfer.types.includes(LIBRARY_ENTRY_MIME);
}

/** The entry key carried by a drop, if any. */
export function readEntryDrop(event: DragEvent): string | null {
  return event.dataTransfer.getData(LIBRARY_ENTRY_MIME) || null;
}
