import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { ContextMenu } from "radix-ui";
import { useQueryClient } from "@tanstack/react-query";
import { Disc3, Heart, ListEnd, ListPlus, ListStart, Mic2, Plus } from "lucide-react";
import type { Track } from "@/api/provider";
import { usePlaylists, useSetStarred } from "@/api/queries";
import { useProvider } from "@/api/session";
import { describeError } from "@/api/errors";
import { usePlayer } from "@/player/store";
import { toast, toastError } from "@/components/ui/toast";

export const menuContent =
  "z-50 min-w-[220px] max-w-[340px] overflow-hidden rounded-md bg-elevated p-1 text-sm shadow-[0_16px_24px_rgb(0_0_0/0.3),0_6px_8px_rgb(0_0_0/0.2)]";
export const menuItem =
  "flex h-10 cursor-default items-center gap-3 rounded-sm px-3 text-text outline-none select-none data-[highlighted]:bg-highlight data-[disabled]:opacity-40";
export const menuSeparator = "my-1 h-px bg-divider";

export interface TrackMenuProps {
  /** Tracks the actions apply to (the selection, or the right-clicked row). */
  tracks: Track[];
  children: ReactNode;
  /** Extra items, e.g. "Aus Playlist entfernen". */
  extra?: ReactNode;
}

/** Right-click menu for one or more tracks. */
export function TrackMenu({ tracks, children, extra }: TrackMenuProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const provider = useProvider();
  const client = useQueryClient();
  const playlists = usePlaylists();
  const setStarred = useSetStarred();
  const single = tracks.length === 1 ? tracks[0] : undefined;
  const allStarred = tracks.every((tr) => tr.starred);

  async function addToPlaylist(id: string, name: string) {
    try {
      await provider.addToPlaylist(
        id,
        tracks.map((tr) => tr.id),
      );
      void client.invalidateQueries({ queryKey: [provider.server.id, "playlist", id] });
      void client.invalidateQueries({ queryKey: [provider.server.id, "playlists"] });
      toast(t("menu.addedToPlaylist", { name }));
    } catch (error) {
      toastError(describeError(t, error));
    }
  }

  async function createPlaylistWithTracks() {
    try {
      const name = single ? single.title : t("menu.newPlaylistName");
      await provider.createPlaylist(
        name,
        tracks.map((tr) => tr.id),
      );
      void client.invalidateQueries({ queryKey: [provider.server.id, "playlists"] });
      toast(t("menu.playlistCreated", { name }));
    } catch (error) {
      toastError(describeError(t, error));
    }
  }

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={menuContent}>
          <ContextMenu.Item
            className={menuItem}
            onSelect={() => {
              usePlayer.getState().addToQueue(tracks);
              toast(t("menu.addedToQueue"));
            }}
          >
            <ListEnd size={16} /> {t("menu.addToQueue")}
          </ContextMenu.Item>
          <ContextMenu.Item
            className={menuItem}
            onSelect={() => {
              usePlayer.getState().playNext(tracks);
              toast(t("menu.playingNext"));
            }}
          >
            <ListStart size={16} /> {t("menu.playNext")}
          </ContextMenu.Item>
          <ContextMenu.Separator className={menuSeparator} />
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className={menuItem}>
              <ListPlus size={16} /> {t("menu.addToPlaylist")}
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent className={`${menuContent} max-h-[60vh] overflow-y-auto`}>
                <ContextMenu.Item className={menuItem} onSelect={() => void createPlaylistWithTracks()}>
                  <Plus size={16} /> {t("menu.newPlaylist")}
                </ContextMenu.Item>
                <ContextMenu.Separator className={menuSeparator} />
                {(playlists.data ?? [])
                  .filter((p) => !p.readOnly)
                  .map((p) => (
                    <ContextMenu.Item
                      key={p.id}
                      className={menuItem}
                      onSelect={() => void addToPlaylist(p.id, p.name)}
                    >
                      <span className="truncate">{p.name}</span>
                    </ContextMenu.Item>
                  ))}
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
          <ContextMenu.Item
            className={menuItem}
            onSelect={() => {
              for (const tr of tracks) setStarred.mutate({ kind: "track", id: tr.id, starred: !allStarred });
              toast(allStarred ? t("menu.removedFromLiked") : t("menu.addedToLiked"));
            }}
          >
            <Heart size={16} className={allStarred ? "fill-accent text-accent" : ""} />
            {allStarred ? t("menu.removeFromLiked") : t("menu.addToLiked")}
          </ContextMenu.Item>
          {extra}
          {single && (single.artists[0]?.id || single.album) && (
            <ContextMenu.Separator className={menuSeparator} />
          )}
          {single?.artists[0]?.id && (
            <ContextMenu.Item
              className={menuItem}
              onSelect={() => navigate(`/artist/${single.artists[0]!.id}`)}
            >
              <Mic2 size={16} /> {t("menu.goToArtist")}
            </ContextMenu.Item>
          )}
          {single?.album && (
            <ContextMenu.Item className={menuItem} onSelect={() => navigate(`/album/${single.album!.id}`)}>
              <Disc3 size={16} /> {t("menu.goToAlbum")}
            </ContextMenu.Item>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
