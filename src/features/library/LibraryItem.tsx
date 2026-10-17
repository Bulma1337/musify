import { memo, useRef, useState, type DragEvent } from "react";
import { NavLink } from "react-router";
import { useTranslation } from "react-i18next";
import { ContextMenu } from "radix-ui";
import { ChevronRight, FolderInput, FolderMinus, FolderPlus, Pin, PinOff, Volume2 } from "lucide-react";
import { Cover } from "@/components/media/Cover";
import { menuContent, menuItem, menuSeparator } from "@/components/media/TrackMenu";
import { cn } from "@/lib/cn";
import { currentTrackDrag, isTrackDrag, readTrackDrop, type DraggedTracks } from "@/lib/dnd";
import { usePlayer } from "@/player/store";
import { LibraryDownloadMark } from "./LibraryDownloadMark";
import { startEntryDrag } from "./libraryDnd";
import type { LibraryEntry } from "./libraryModel";
import { useLibrary, useLibraryPrefs } from "./libraryStore";

export interface LibraryItemProps {
  entry: LibraryEntry;
  serverId: string;
  collapsed: boolean;
  depth: 0 | 1;
  pinned: boolean;
  /** Folder the playlist is filed in. */
  folderId?: string;
  onDropTracks(entry: LibraryEntry, tracks: DraggedTracks): void;
  /** Creates a folder, files the entry into it and starts renaming it. */
  onNewFolder(entryKey: string): void;
}

/** Folder choices of the "move to folder" submenu; only mounted while the submenu is open. */
function FolderChoices({
  serverId,
  entryKey,
  folderId,
  onNewFolder,
  keepFocusOutRef,
}: {
  serverId: string;
  entryKey: string;
  folderId?: string;
  onNewFolder(entryKey: string): void;
  keepFocusOutRef: { current: boolean };
}) {
  const { t } = useTranslation();
  const { folders } = useLibraryPrefs(serverId);
  return (
    <>
      {folders.map((folder) => (
        <ContextMenu.Item
          key={folder.id}
          className={cn(menuItem, folder.id === folderId && "text-accent")}
          disabled={folder.id === folderId}
          onSelect={() => useLibrary.getState().moveToFolder(serverId, entryKey, folder.id)}
        >
          <span className="truncate">{folder.name}</span>
        </ContextMenu.Item>
      ))}
      {folders.length > 0 && <ContextMenu.Separator className={menuSeparator} />}
      <ContextMenu.Item
        className={menuItem}
        onSelect={() => {
          keepFocusOutRef.current = true;
          onNewFolder(entryKey);
        }}
      >
        <FolderPlus size={16} /> {t("libraryExtras.newFolderEllipsis")}
      </ContextMenu.Item>
    </>
  );
}

function LibraryItemImpl({
  entry,
  serverId,
  collapsed,
  depth,
  pinned,
  folderId,
  onDropTracks,
  onNewFolder,
}: LibraryItemProps) {
  const { t } = useTranslation();
  const playing = usePlayer(
    (s) =>
      s.isPlaying &&
      !!s.context &&
      ((entry.kind === "liked" && s.context.type === "liked") ||
        (s.context.type === entry.kind && s.context.id === entry.id)),
  );
  const [over, setOver] = useState(false);
  // Radix hands focus back to the row after the menu closes; that would steal it from the rename field.
  const keepFocusOut = useRef(false);

  const acceptsTracks = entry.kind === "liked" || (entry.kind === "playlist" && !entry.readOnly);
  const ownOrigin = entry.kind === "playlist" ? `playlist:${entry.id}` : null;

  function onDragOver(event: DragEvent) {
    if (!acceptsTracks || !isTrackDrag(event)) return;
    // Dragging tracks of a playlist onto itself is a reorder, not an add.
    if (ownOrigin && currentTrackDrag()?.origin === ownOrigin) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setOver(true);
  }

  function onDragLeave(event: DragEvent) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
  }

  function onDrop(event: DragEvent) {
    if (!acceptsTracks || !isTrackDrag(event)) return;
    event.preventDefault();
    setOver(false);
    const tracks = readTrackDrop(event);
    if (tracks && tracks.trackIds.length > 0) onDropTracks(entry, tracks);
  }

  const row = (
    <div
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        "rounded-md",
        depth === 1 && !collapsed && "ml-5",
        over && "bg-highlight outline-2 -outline-offset-2 outline-accent",
      )}
    >
      <NavLink
        to={entry.to}
        title={collapsed ? entry.title : undefined}
        draggable={entry.kind === "playlist" ? true : undefined}
        onDragStart={entry.kind === "playlist" ? (event) => startEntryDrag(event, entry.key) : undefined}
        className={({ isActive }) =>
          cn(
            // The rail is 72 px wide: 8 px padding on each side leaves room for the 48 px cover plus 4 px.
            "flex items-center rounded-md transition-colors hover:bg-highlight",
            collapsed ? "justify-center p-1" : "gap-3 p-2",
            isActive && "bg-highlight hover:bg-press",
          )
        }
      >
        <Cover
          cover={entry.cover}
          size={48}
          round={entry.kind === "artist"}
          fallback={entry.kind === "liked" ? "liked" : entry.kind}
          className="w-12 shadow-none"
        />
        {!collapsed && (
          <>
            <div className="min-w-0 flex-1">
              <p className={cn("truncate", playing && "text-accent")}>{entry.title}</p>
              <p className="flex min-w-0 items-center gap-1.5 text-sm text-subdued">
                <LibraryDownloadMark entry={entry} />
                <span className="truncate">{entry.subtitle}</span>
              </p>
            </div>
            {pinned && (
              <Pin
                size={14}
                aria-label={t("libraryExtras.pinned")}
                className="shrink-0 rotate-45 fill-current text-subdued"
              />
            )}
            {playing && <Volume2 size={16} className="shrink-0 text-accent" />}
          </>
        )}
      </NavLink>
    </div>
  );

  // Favorites is always pinned and cannot be filed anywhere, so there is nothing to offer.
  if (entry.kind === "liked") return row;

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{row}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className={menuContent}
          onCloseAutoFocus={(event) => {
            if (keepFocusOut.current) {
              event.preventDefault();
              keepFocusOut.current = false;
            }
          }}
        >
          <ContextMenu.Item
            className={menuItem}
            onSelect={() => useLibrary.getState().togglePin(serverId, entry.key)}
          >
            {pinned ? <PinOff size={16} /> : <Pin size={16} />}
            {pinned ? t("libraryExtras.unpin") : t("libraryExtras.pin")}
          </ContextMenu.Item>
          {entry.kind === "playlist" && (
            <>
              <ContextMenu.Separator className={menuSeparator} />
              <ContextMenu.Sub>
                <ContextMenu.SubTrigger className={menuItem}>
                  <FolderInput size={16} />
                  <span className="flex-1">{t("libraryExtras.moveToFolder")}</span>
                  <ChevronRight size={16} />
                </ContextMenu.SubTrigger>
                <ContextMenu.Portal>
                  <ContextMenu.SubContent className={`${menuContent} max-h-[60vh] overflow-y-auto`}>
                    <FolderChoices
                      serverId={serverId}
                      entryKey={entry.key}
                      folderId={folderId}
                      onNewFolder={onNewFolder}
                      keepFocusOutRef={keepFocusOut}
                    />
                  </ContextMenu.SubContent>
                </ContextMenu.Portal>
              </ContextMenu.Sub>
              {folderId && (
                <ContextMenu.Item
                  className={menuItem}
                  onSelect={() => useLibrary.getState().moveToFolder(serverId, entry.key, null)}
                >
                  <FolderMinus size={16} /> {t("libraryExtras.removeFromFolder")}
                </ContextMenu.Item>
              )}
            </>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** One row of the library sidebar (also the collapsed rail tile): link, pin menu and drop target. */
export const LibraryItem = memo(LibraryItemImpl);
