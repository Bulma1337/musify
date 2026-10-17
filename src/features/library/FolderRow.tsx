import { memo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { ContextMenu } from "radix-ui";
import { ChevronDown, ChevronRight, Folder, FolderOpen, Pencil, Trash2 } from "lucide-react";
import { menuContent, menuItem } from "@/components/media/TrackMenu";
import { cn } from "@/lib/cn";
import { isEntryDrag, readEntryDrop } from "./libraryDnd";
import { useLibrary, type LibraryFolder } from "./libraryStore";

export interface FolderRowProps {
  folder: LibraryFolder;
  serverId: string;
  count: number;
  /** Collapsed sidebar: show only the folder icon. */
  rail: boolean;
  editing: boolean;
  onEdit(folderId: string | null): void;
}

function FolderRowImpl({ folder, serverId, count, rail, editing, onEdit }: FolderRowProps) {
  const { t } = useTranslation();
  const [over, setOver] = useState(false);
  const [draft, setDraft] = useState(folder.name);
  const finished = useRef(false);
  // Radix hands focus back to the row after the menu closes; that would steal it from the rename field.
  const keepFocusOut = useRef(false);
  const Icon = folder.collapsed ? Folder : FolderOpen;

  function onDragOver(event: DragEvent) {
    if (!isEntryDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setOver(true);
  }

  function onDrop(event: DragEvent) {
    if (!isEntryDrag(event)) return;
    event.preventDefault();
    setOver(false);
    const key = readEntryDrop(event);
    if (key) useLibrary.getState().moveToFolder(serverId, key, folder.id);
  }

  function finishEdit(save: boolean) {
    if (finished.current) return;
    finished.current = true;
    if (save) useLibrary.getState().renameFolder(serverId, folder.id, draft);
    onEdit(null);
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Enter") finishEdit(true);
    else if (event.key === "Escape") finishEdit(false);
  }

  const tile = (
    <span className="grid size-12 shrink-0 place-items-center rounded-[4px] bg-highlight text-subdued">
      <Icon size={22} strokeWidth={1.5} />
    </span>
  );

  const row = (
    <div
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={onDrop}
      className={cn("rounded-md", over && "bg-highlight outline-2 -outline-offset-2 outline-accent")}
    >
      {editing && !rail ? (
        <div className="flex items-center gap-3 rounded-md p-2">
          {tile}
          <input
            autoFocus
            aria-label={t("libraryExtras.folderName")}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={(event) => event.target.select()}
            onKeyDown={onKeyDown}
            onBlur={() => finishEdit(true)}
            maxLength={80}
            className="h-8 min-w-0 flex-1 rounded-md bg-highlight px-2 outline-none"
          />
        </div>
      ) : (
        <button
          type="button"
          aria-expanded={!folder.collapsed}
          title={rail ? folder.name : undefined}
          onClick={() => useLibrary.getState().toggleFolder(serverId, folder.id)}
          className="flex w-full items-center gap-3 rounded-md p-2 text-left transition-colors hover:bg-highlight"
        >
          {tile}
          {!rail && (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{folder.name}</span>
                <span className="block truncate text-sm text-subdued">
                  {t("libraryExtras.folderItems", { count })}
                </span>
              </span>
              {folder.collapsed ? (
                <ChevronRight size={16} className="shrink-0 text-subdued" />
              ) : (
                <ChevronDown size={16} className="shrink-0 text-subdued" />
              )}
            </>
          )}
        </button>
      )}
    </div>
  );

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
            onSelect={() => {
              keepFocusOut.current = true;
              finished.current = false;
              setDraft(folder.name);
              onEdit(folder.id);
            }}
          >
            <Pencil size={16} /> {t("libraryExtras.renameFolder")}
          </ContextMenu.Item>
          <ContextMenu.Item
            className={menuItem}
            onSelect={() => useLibrary.getState().deleteFolder(serverId, folder.id)}
          >
            <Trash2 size={16} /> {t("libraryExtras.deleteFolder")}
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** Folder row of the library sidebar: expand/collapse, rename, delete, drop target for playlists. */
export const FolderRow = memo(FolderRowImpl);
