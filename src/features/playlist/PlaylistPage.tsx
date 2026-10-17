import { useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { AlertDialog, ContextMenu, DropdownMenu } from "radix-ui";
import {
  Ellipsis,
  Globe,
  ImageOff,
  ImagePlus,
  ListEnd,
  ListMusic,
  ListX,
  Lock,
  Pencil,
  Search,
  Shuffle,
  Trash2,
} from "lucide-react";
import type { PlaylistDetail } from "@/api/provider";
import { hasCustomCover, imageFileToCover, useCustomCovers } from "@/api/customCovers";
import { usePlaylist } from "@/api/queries";
import { useProvider } from "@/api/session";
import { describeError } from "@/api/errors";
import { PageHeader } from "@/components/media/PageHeader";
import { TrackList } from "@/components/media/TrackList";
import { menuContent, menuItem, menuSeparator } from "@/components/media/TrackMenu";
import { Button, IconButton } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { toast, toastError } from "@/components/ui/toast";
import { DownloadButton } from "@/features/downloads/DownloadButton";
import { playlistSpec } from "@/features/downloads/specs";
import { moveItems } from "@/lib/dnd";
import { formatLongDuration } from "@/lib/format";
import { loaders, playOrToggle, useIsContextPlaying } from "@/player/actions";
import { usePlayer } from "@/player/store";
import { dialogContent, dialogOverlay, EditPlaylistDialog } from "./EditPlaylistDialog";

function PlaylistView({ playlist }: { playlist: PlaylistDetail }) {
  const { t } = useTranslation();
  const provider = useProvider();
  const client = useQueryClient();
  const navigate = useNavigate();
  const playing = useIsContextPlaying("playlist", playlist.id);
  const [filter, setFilter] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const editable = !playlist.readOnly;
  const imageInput = useRef<HTMLInputElement>(null);
  const customImage = useCustomCovers((s) => hasCustomCover(s.images, provider.server.id, playlist.id));
  const context = { type: "playlist" as const, id: playlist.id, name: playlist.name };

  // Keep each entry's original position: removal works on server positions, not filtered ones.
  const entries = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = playlist.tracks.map((track, index) => ({ track, index }));
    if (!q) return all;
    return all.filter(
      ({ track }) =>
        track.title.toLowerCase().includes(q) ||
        track.artistLine.toLowerCase().includes(q) ||
        (track.album?.name.toLowerCase().includes(q) ?? false),
    );
  }, [playlist.tracks, filter]);
  const visibleTracks = useMemo(() => entries.map((e) => e.track), [entries]);

  function invalidate() {
    void client.invalidateQueries({ queryKey: [provider.server.id, "playlist", playlist.id] });
    void client.invalidateQueries({ queryKey: [provider.server.id, "playlists"] });
  }

  /** Drag-and-drop reorder: optimistic update, then the server; rolls back on failure. */
  async function reorder(from: number[], to: number) {
    const key = [provider.server.id, "playlist", playlist.id];
    const previous = client.getQueryData<PlaylistDetail>(key);
    const tracks = moveItems(playlist.tracks, from, to);
    client.setQueryData<PlaylistDetail>(key, { ...playlist, tracks });
    try {
      await provider.reorderPlaylist(playlist.id, tracks);
      invalidate();
    } catch (error) {
      if (previous) client.setQueryData(key, previous);
      toastError(describeError(t, error));
    }
  }

  async function update(changes: { name?: string; comment?: string; public?: boolean }, message: string) {
    setSaving(true);
    try {
      await provider.updatePlaylist(playlist.id, changes);
      invalidate();
      setEditOpen(false);
      toast(message);
    } catch (error) {
      toastError(describeError(t, error));
    } finally {
      setSaving(false);
    }
  }

  async function remove(indices: number[]) {
    try {
      await provider.removeFromPlaylist(playlist.id, indices);
      invalidate();
      toast(t("playlist.removed", { count: indices.length }));
    } catch (error) {
      toastError(describeError(t, error));
    }
  }

  async function deletePlaylist() {
    try {
      await provider.deletePlaylist(playlist.id);
      void client.invalidateQueries({ queryKey: [provider.server.id, "playlists"] });
      toast(t("playlist.deleted", { name: playlist.name }));
      navigate("/");
    } catch (error) {
      toastError(describeError(t, error));
    }
  }

  function shuffle() {
    const player = usePlayer.getState();
    const tracks = playlist.tracks;
    if (tracks.length === 0) return;
    player.playTracks(tracks, Math.floor(Math.random() * tracks.length), context);
    player.setShuffle("shuffle");
  }

  async function changeImage(file: File) {
    try {
      const dataUrl = await imageFileToCover(file);
      useCustomCovers.getState().setImage(provider.server.id, playlist.id, dataUrl);
      toast(t("playlist.imageChanged"));
    } catch {
      toastError(t("playlist.imageFailed"));
    }
  }

  const metaParts = [
    playlist.owner,
    t("playlist.trackCount", { count: playlist.trackCount || playlist.tracks.length }),
    formatLongDuration(playlist.durationMs),
  ].filter(Boolean);

  return (
    <div>
      <input
        ref={imageInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void changeImage(file);
        }}
      />
      <div className="contents">
        <PageHeader
          titleAction={
            editable ? (
              <IconButton label={t("playlist.editDetails")} size={36} onClick={() => setEditOpen(true)}>
                <Pencil size={20} />
              </IconButton>
            ) : undefined
          }
          coverAction={
            editable
              ? { label: t("playlist.changeImage"), icon: <ImagePlus size={28} />, onClick: () => imageInput.current?.click() }
              : undefined
          }
          kind={playlist.public ? t("playlist.kindPublic") : t("playlist.kindPrivate")}
          title={playlist.name}
          cover={playlist.cover}
          coverFallback="playlist"
          description={playlist.comment}
          meta={metaParts.map((part, i) => (
            <span key={i} className={i === 0 && playlist.owner ? "font-bold" : undefined}>
              {i > 0 && <span className="mx-1">•</span>}
              {part}
            </span>
          ))}
          playing={playing}
          onPlay={() => playOrToggle(context, loaders.playlist(provider, playlist.id))}
          actions={
            <>
              <IconButton label={t("playlist.shuffle")} size={40} onClick={shuffle}>
                <Shuffle size={24} />
              </IconButton>
              <DownloadButton spec={playlistSpec(playlist)} />
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <IconButton label={t("playlist.actions")} size={40}>
                    <Ellipsis size={28} />
                  </IconButton>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content align="start" className={menuContent}>
                    {editable && (
                      <DropdownMenu.Item className={menuItem} onSelect={() => setEditOpen(true)}>
                        <Pencil size={16} /> {t("playlist.editDetails")}
                      </DropdownMenu.Item>
                    )}
                    {editable && (
                      <DropdownMenu.Item className={menuItem} onSelect={() => imageInput.current?.click()}>
                        <ImagePlus size={16} /> {t("playlist.changeImage")}
                      </DropdownMenu.Item>
                    )}
                    {editable && customImage && (
                      <DropdownMenu.Item
                        className={menuItem}
                        onSelect={() => {
                          useCustomCovers.getState().removeImage(provider.server.id, playlist.id);
                          toast(t("playlist.imageRemoved"));
                        }}
                      >
                        <ImageOff size={16} /> {t("playlist.removeImage")}
                      </DropdownMenu.Item>
                    )}
                    {editable && provider.capabilities.publicPlaylists && (
                      <DropdownMenu.Item
                        className={menuItem}
                        onSelect={() =>
                          void update(
                            { public: !playlist.public },
                            playlist.public ? t("playlist.nowPrivate") : t("playlist.nowPublic"),
                          )
                        }
                      >
                        {playlist.public ? <Lock size={16} /> : <Globe size={16} />}
                        {playlist.public ? t("playlist.makePrivate") : t("playlist.makePublic")}
                      </DropdownMenu.Item>
                    )}
                    <DropdownMenu.Item
                      className={menuItem}
                      disabled={playlist.tracks.length === 0}
                      onSelect={() => {
                        usePlayer.getState().addToQueue(playlist.tracks);
                        toast(t("menu.addedToQueue"));
                      }}
                    >
                      <ListEnd size={16} /> {t("playlist.addToQueue")}
                    </DropdownMenu.Item>
                    {editable && (
                      <>
                        <DropdownMenu.Separator className={menuSeparator} />
                        <DropdownMenu.Item className={menuItem} onSelect={() => setDeleteOpen(true)}>
                          <Trash2 size={16} /> {t("playlist.delete")}
                        </DropdownMenu.Item>
                      </>
                    )}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
              <div className="ml-auto flex h-8 items-center gap-2 rounded-md bg-white/10 px-2.5 text-subdued focus-within:text-text">
                <Search size={16} aria-hidden />
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  aria-label={t("playlist.filterLabel")}
                  placeholder={t("playlist.filterPlaceholder")}
                  className="w-40 bg-transparent text-sm text-text outline-none placeholder:text-muted"
                />
              </div>
            </>
          }
        />
      </div>

      <div className="px-6 pb-8">
        {playlist.tracks.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <ListMusic size={48} className="text-subdued" strokeWidth={1.5} />
            <h2 className="text-2xl font-bold tracking-tight">{t("playlist.emptyTitle")}</h2>
            <p className="max-w-sm text-subdued">{t("playlist.emptyHint")}</p>
          </div>
        ) : visibleTracks.length === 0 ? (
          <p className="py-12 text-center text-subdued">
            {t("playlist.noMatches", { query: filter.trim() })}
          </p>
        ) : (
          <TrackList
            tracks={visibleTracks}
            dragOrigin={`playlist:${playlist.id}`}
            // Reordering only makes sense on the full, unfiltered list.
            onReorder={editable && !filter.trim() ? (from, to) => void reorder(from, to) : undefined}
            onPlay={(index) => usePlayer.getState().playTracks(visibleTracks, index, context)}
            menuExtra={
              editable
                ? (_tracks, indices) => (
                    <>
                      <ContextMenu.Separator className={menuSeparator} />
                      <ContextMenu.Item
                        className={menuItem}
                        onSelect={() => void remove(indices.map((i) => entries[i]!.index))}
                      >
                        <ListX size={16} /> {t("playlist.removeFromPlaylist")}
                      </ContextMenu.Item>
                    </>
                  )
                : undefined
            }
          />
        )}
      </div>

      {editable && (
        <>
          <EditPlaylistDialog
            open={editOpen}
            onOpenChange={setEditOpen}
            initial={{ name: playlist.name, comment: playlist.comment ?? "" }}
            saving={saving}
            onSave={(values) => void update(values, t("playlist.saved"))}
          />
          <AlertDialog.Root open={deleteOpen} onOpenChange={setDeleteOpen}>
            <AlertDialog.Portal>
              <AlertDialog.Overlay className={dialogOverlay} />
              <AlertDialog.Content className={dialogContent}>
                <AlertDialog.Title className="text-2xl font-bold tracking-tight">
                  {t("playlist.deleteTitle", { name: playlist.name })}
                </AlertDialog.Title>
                <AlertDialog.Description className="mt-3 text-subdued">
                  {t("playlist.deleteBody")}
                </AlertDialog.Description>
                <div className="mt-6 flex justify-end gap-3">
                  <AlertDialog.Cancel asChild>
                    <Button variant="ghost">{t("playlist.cancel")}</Button>
                  </AlertDialog.Cancel>
                  <AlertDialog.Action asChild>
                    <Button variant="danger" onClick={() => void deletePlaylist()}>
                      {t("playlist.delete")}
                    </Button>
                  </AlertDialog.Action>
                </div>
              </AlertDialog.Content>
            </AlertDialog.Portal>
          </AlertDialog.Root>
        </>
      )}
    </div>
  );
}

export function PlaylistPage() {
  const { id } = useParams();
  const { t } = useTranslation();
  const playlist = usePlaylist(id);

  if (playlist.isPending) {
    return (
      <div className="grid h-64 place-items-center text-subdued">
        <Spinner />
      </div>
    );
  }
  if (playlist.isError) {
    return <p className="p-6 text-subdued">{describeError(t, playlist.error)}</p>;
  }
  return <PlaylistView playlist={playlist.data} />;
}
