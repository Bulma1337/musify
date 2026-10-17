import type { DragEvent } from "react";
import type { Track } from "@/api/provider";

/**
 * Drag-and-drop contract between track lists, the queue and the library sidebar. Uses native HTML5
 * drag events (works with virtualized lists; Tauri's own file drop is disabled for this).
 */
export const TRACKS_MIME = "application/x-musify-tracks";

export interface DraggedTracks {
  /** Track ids in display order. */
  trackIds: string[];
  /** Where the drag started, e.g. "playlist:<id>", "album:<id>", "queue". */
  origin: string;
  /** Positions inside the origin list (used for reordering within the same list). */
  indices: number[];
}

/** Payload of the drag in progress (dataTransfer content is unreadable during dragover). */
let current: DraggedTracks | null = null;
/** The dragged Track objects (kept in memory only; drop targets like the queue need full tracks). */
let currentTracks: Track[] = [];

export function startTrackDrag(
  event: DragEvent,
  payload: DraggedTracks,
  label: string,
  tracks: Track[] = [],
): void {
  current = payload;
  currentTracks = tracks;
  event.dataTransfer.effectAllowed = "copyMove";
  event.dataTransfer.setData(TRACKS_MIME, JSON.stringify(payload));
  event.dataTransfer.setData("text/plain", label);

  // Compact drag image with the item count instead of a ghost of the whole row.
  const ghost = document.createElement("div");
  ghost.textContent = label;
  ghost.style.cssText =
    "position:fixed;top:-100px;left:0;padding:6px 12px;border-radius:6px;background:#2a2a2a;color:#fff;" +
    "font:600 13px Figtree Variable,sans-serif;white-space:nowrap;";
  document.body.appendChild(ghost);
  event.dataTransfer.setDragImage(ghost, 12, 12);
  setTimeout(() => ghost.remove(), 0);
}

export function endTrackDrag(): void {
  current = null;
  currentTracks = [];
}

/** Full Track objects of the drag in progress (empty if the source did not provide them). */
export function currentDraggedTracks(): Track[] {
  return currentTracks;
}

/** The drag in progress, if it carries tracks. */
export function currentTrackDrag(): DraggedTracks | null {
  return current;
}

/** True if the event carries Musify tracks (usable in dragenter/dragover to accept the drop). */
export function isTrackDrag(event: DragEvent): boolean {
  return event.dataTransfer.types.includes(TRACKS_MIME);
}

export function readTrackDrop(event: DragEvent): DraggedTracks | null {
  try {
    const raw = event.dataTransfer.getData(TRACKS_MIME);
    return raw ? (JSON.parse(raw) as DraggedTracks) : current;
  } catch {
    return current;
  }
}

/**
 * Moves the items at `from` (sorted, unique indices) to `to` (insertion index in the original list)
 * and returns the new array. Keeps the moved items' relative order.
 */
export function moveItems<T>(items: readonly T[], from: readonly number[], to: number): T[] {
  const moving = new Set(from);
  const moved = from.map((i) => items[i]).filter((x): x is T => x !== undefined);
  const rest = items.filter((_, i) => !moving.has(i));
  const insertAt = to - from.filter((i) => i < to).length;
  return [...rest.slice(0, insertAt), ...moved, ...rest.slice(insertAt)];
}
