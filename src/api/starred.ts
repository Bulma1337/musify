import { create } from "zustand";
import type { StarrableKind } from "./provider";

/**
 * Favorite changes made in this session, applied at once everywhere. Server lists catch up when
 * they are refetched; snapshots that are never refetched (queue items, the playing track) would
 * otherwise keep the old state, so these entries win over the `starred` flag of any item.
 */
interface StarredState {
  changes: Record<string, boolean>;
  set(serverId: string, kind: StarrableKind, id: string, starred: boolean): void;
  /** Restores an entry (failed request): `undefined` removes it. */
  restore(serverId: string, kind: StarrableKind, id: string, previous: boolean | undefined): void;
}

const keyOf = (serverId: string, kind: StarrableKind, id: string) => `${serverId}:${kind}:${id}`;

export const useStarredChanges = create<StarredState>((set) => ({
  changes: {},
  set: (serverId, kind, id, starred) =>
    set((s) => ({ changes: { ...s.changes, [keyOf(serverId, kind, id)]: starred } })),
  restore: (serverId, kind, id, previous) =>
    set((s) => {
      const changes = { ...s.changes };
      const key = keyOf(serverId, kind, id);
      if (previous === undefined) delete changes[key];
      else changes[key] = previous;
      return { changes };
    }),
}));

export function starredChange(serverId: string, kind: StarrableKind, id: string): boolean | undefined {
  return useStarredChanges.getState().changes[keyOf(serverId, kind, id)];
}

/** Resolves an item's favorite state: a change made here wins over the item's own flag. */
export function resolveStarred(
  changes: Record<string, boolean>,
  serverId: string | undefined,
  kind: StarrableKind,
  id: string | undefined,
  fallback: boolean | undefined,
): boolean {
  if (!serverId || !id) return !!fallback;
  return changes[keyOf(serverId, kind, id)] ?? !!fallback;
}
