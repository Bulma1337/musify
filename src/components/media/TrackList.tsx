import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Clock3, Disc3, Ellipsis, Heart, Play } from "lucide-react";
import type { Track } from "@/api/provider";
import { useSetStarred } from "@/api/queries";
import { useScrollContainer } from "@/app/layout/scrollContainer";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/format";
import { usePlayer } from "@/player/store";
import { Cover } from "./Cover";
import { TrackMenu } from "./TrackMenu";

const ROW_HEIGHT = 56;
const DISC_ROW_HEIGHT = 48;

type Row = { kind: "disc"; disc: number; title?: string } | { kind: "track"; index: number; track: Track };

export interface TrackListProps {
  tracks: Track[];
  /** Start playback of the list at a track index. */
  onPlay: (index: number) => void;
  showCover?: boolean;
  showAlbum?: boolean;
  /** Text for the "Hinzugefügt am" column; column hidden when not given. */
  addedAt?: (track: Track, index: number) => string | undefined;
  /** Insert "CD 1 / CD 2" separators (album view). */
  showDiscs?: boolean;
  discTitles?: Record<number, string>;
  /** Show the track's own number instead of the list position. */
  useTrackNumbers?: boolean;
  /** Extra context-menu entries for the selected tracks. */
  menuExtra?: (tracks: Track[], indices: number[]) => ReactNode;
}

function EqualizerBars() {
  return (
    <span className="flex h-3.5 items-end gap-[2px]" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className="w-[3px] origin-bottom animate-[eq-bar_0.9s_ease-in-out_infinite] rounded-[1px] bg-accent"
          style={{ animationDelay: `${i * -0.23}s`, height: "100%" }}
        />
      ))}
    </span>
  );
}

function ArtistLinks({ track }: { track: Track }) {
  if (track.artists.length === 0) return <>{track.artistLine}</>;
  return (
    <>
      {track.artists.map((a, i) => (
        <span key={`${a.id ?? a.name}-${i}`}>
          {i > 0 && ", "}
          {a.id ? (
            <Link
              to={`/artist/${a.id}`}
              className="hover:text-text hover:underline"
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              {a.name}
            </Link>
          ) : (
            a.name
          )}
        </span>
      ))}
    </>
  );
}

interface RowProps {
  row: Extract<Row, { kind: "track" }>;
  number: number;
  gridTemplate: string;
  showCover: boolean;
  showAlbum: boolean;
  added?: string;
  hasAdded: boolean;
  selected: boolean;
  isCurrent: boolean;
  isPlaying: boolean;
  onMouseDown: (e: React.MouseEvent, index: number) => void;
  onPlay: (index: number) => void;
}

const TrackRow = memo(function TrackRow({
  row,
  number,
  gridTemplate,
  showCover,
  showAlbum,
  added,
  hasAdded,
  selected,
  isCurrent,
  isPlaying,
  onMouseDown,
  onPlay,
}: RowProps) {
  const { t } = useTranslation();
  const setStarred = useSetStarred();
  const { track, index } = row;

  return (
    <div
      role="row"
      aria-selected={selected}
      onMouseDown={(e) => onMouseDown(e, index)}
      onDoubleClick={() => onPlay(index)}
      className={cn(
        "group grid h-14 items-center gap-4 rounded-[4px] px-4 text-sm text-subdued",
        selected ? "bg-press/80 hover:bg-press" : "hover:bg-white/10",
      )}
      style={{ gridTemplateColumns: gridTemplate }}
    >
      <div className="relative flex w-full justify-end tabular-nums">
        {isPlaying ? (
          <span className="group-hover:invisible">
            <EqualizerBars />
          </span>
        ) : (
          <span className={cn("text-base group-hover:invisible", isCurrent && "text-accent")}>{number}</span>
        )}
        <button
          type="button"
          aria-label={t("player.playTrack", { title: track.title })}
          onClick={() => onPlay(index)}
          className="invisible absolute inset-y-0 right-0 grid place-items-center text-text group-hover:visible"
        >
          <Play size={14} fill="currentColor" strokeWidth={0} />
        </button>
      </div>

      <div className="flex min-w-0 items-center gap-3">
        {showCover && <Cover cover={track.cover} size={40} fallback="track" className="w-10 shadow-none" />}
        <div className="min-w-0">
          <p
            className={cn("truncate text-base", isCurrent ? "text-accent" : "text-text")}
            title={track.title}
          >
            {track.title}
          </p>
          <p className="flex min-w-0 items-center gap-1.5 truncate">
            {track.explicit && (
              <span
                className="grid h-4 min-w-4 shrink-0 place-items-center rounded-[2px] bg-subdued px-1 text-[9px] font-bold text-black"
                title={t("track.explicit")}
              >
                E
              </span>
            )}
            <span className="truncate group-hover:text-text">
              <ArtistLinks track={track} />
            </span>
          </p>
        </div>
      </div>

      {showAlbum && (
        <div className="min-w-0 truncate">
          {track.album && (
            <Link
              to={`/album/${track.album.id}`}
              className="hover:text-text hover:underline"
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              {track.album.name}
            </Link>
          )}
        </div>
      )}

      {hasAdded && <div className="min-w-0 truncate">{added}</div>}

      <div className="flex items-center justify-end gap-3 tabular-nums">
        <button
          type="button"
          aria-label={track.starred ? t("menu.removeFromLiked") : t("menu.addToLiked")}
          onClick={() => setStarred.mutate({ kind: "track", id: track.id, starred: !track.starred })}
          className={cn(
            "transition-transform hover:scale-110",
            track.starred ? "text-accent" : "invisible text-subdued group-hover:visible hover:text-text",
          )}
        >
          <Heart size={16} className={track.starred ? "fill-current" : ""} />
        </button>
        <span className="w-10 text-right">{formatDuration(track.durationMs)}</span>
        <button
          type="button"
          aria-label={t("menu.more")}
          onClick={(e) => {
            // Open the row's context menu at the button (Radix opens on the contextmenu event).
            const rect = e.currentTarget.getBoundingClientRect();
            e.currentTarget.dispatchEvent(
              new MouseEvent("contextmenu", { bubbles: true, clientX: rect.left, clientY: rect.bottom }),
            );
          }}
          className="invisible text-subdued group-hover:visible hover:text-text"
        >
          <Ellipsis size={18} />
        </button>
      </div>
    </div>
  );
});

/**
 * Virtualized track table (album, playlist, liked songs, search). Rows render only when visible, so
 * lists with thousands of tracks stay fast. Selection: click, Ctrl/Cmd toggles, Shift selects a range.
 */
export function TrackList({
  tracks,
  onPlay,
  showCover = true,
  showAlbum = true,
  addedAt,
  showDiscs = false,
  discTitles,
  useTrackNumbers = false,
  menuExtra,
}: TrackListProps) {
  const { t } = useTranslation();
  const scrollElement = useScrollContainer();
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [width, setWidth] = useState(1000);
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const anchor = useRef<number | null>(null);

  const currentId = usePlayer((s) => s.current?.track.id);
  const playing = usePlayer((s) => s.isPlaying);

  const rows = useMemo<Row[]>(() => {
    const discs = new Set(tracks.map((tr) => tr.discNumber ?? 1));
    const withDiscs = showDiscs && discs.size > 1;
    const result: Row[] = [];
    let lastDisc: number | undefined;
    tracks.forEach((track, index) => {
      const disc = track.discNumber ?? 1;
      if (withDiscs && disc !== lastDisc) {
        result.push({ kind: "disc", disc, title: discTitles?.[disc] });
        lastDisc = disc;
      }
      result.push({ kind: "track", index, track });
    });
    return result;
  }, [tracks, showDiscs, discTitles]);

  // Offset of the list inside the scroll container, for the virtualizer.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !scrollElement) return;
    const update = () => {
      const listTop = list.getBoundingClientRect().top;
      const containerTop = scrollElement.getBoundingClientRect().top;
      setScrollMargin(listTop - containerTop + scrollElement.scrollTop);
      setWidth(list.clientWidth);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(list);
    return () => observer.disconnect();
  }, [scrollElement]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollElement,
    estimateSize: (i) => (rows[i]?.kind === "disc" ? DISC_ROW_HEIGHT : ROW_HEIGHT),
    overscan: 12,
    scrollMargin,
  });

  // Drop selections that no longer exist when the list changes.
  useEffect(() => {
    setSelection(new Set());
    anchor.current = null;
  }, [tracks]);

  const hasAdded = !!addedAt && width >= 900;
  const albumVisible = showAlbum && width >= 640;
  const gridTemplate = [
    "2.25rem",
    "minmax(160px, 4fr)",
    albumVisible ? "minmax(120px, 3fr)" : null,
    hasAdded ? "minmax(120px, 2fr)" : null,
    "8rem",
  ]
    .filter(Boolean)
    .join(" ");

  function handleMouseDown(e: React.MouseEvent, index: number) {
    if (e.button === 2) {
      // Right-click on an unselected row selects just that row (menu applies to it).
      if (!selection.has(index)) {
        setSelection(new Set([index]));
        anchor.current = index;
      }
      return;
    }
    if (e.button !== 0) return;
    if (e.shiftKey && anchor.current !== null) {
      const [from, to] = [Math.min(anchor.current, index), Math.max(anchor.current, index)];
      setSelection(new Set(Array.from({ length: to - from + 1 }, (_, i) => from + i)));
    } else if (e.ctrlKey || e.metaKey) {
      const next = new Set(selection);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      setSelection(next);
      anchor.current = index;
    } else {
      setSelection(new Set([index]));
      anchor.current = index;
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (tracks.length === 0) return;
    const current = anchor.current ?? -1;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.min(tracks.length - 1, Math.max(0, current + (e.key === "ArrowDown" ? 1 : -1)));
      anchor.current = next;
      setSelection(new Set([next]));
      const rowIndex = rows.findIndex((r) => r.kind === "track" && r.index === next);
      virtualizer.scrollToIndex(rowIndex, { align: "auto" });
    } else if (e.key === "Enter" && current >= 0) {
      onPlay(current);
    } else if (e.key === "a" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      setSelection(new Set(tracks.map((_, i) => i)));
    } else if (e.key === "Escape") {
      setSelection(new Set());
    }
  }

  const selectedIndices = [...selection].sort((a, b) => a - b);
  const selectedTracks = selectedIndices.map((i) => tracks[i]!).filter(Boolean);

  return (
    <div
      role="grid"
      aria-rowcount={tracks.length}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="outline-none"
    >
      <div
        role="row"
        className="sticky top-16 z-10 mb-2 grid h-9 items-center gap-4 border-b border-divider bg-surface px-4 text-sm text-subdued"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        <span className="text-right">#</span>
        <span>{t("track.title")}</span>
        {albumVisible && <span>{t("track.album")}</span>}
        {hasAdded && <span>{t("track.added")}</span>}
        <span className="flex justify-end pr-7">
          <Clock3 size={16} aria-label={t("track.duration")} />
        </span>
      </div>

      <div ref={listRef} className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          const style = {
            position: "absolute" as const,
            top: 0,
            left: 0,
            right: 0,
            transform: `translateY(${item.start - scrollMargin}px)`,
          };
          if (row.kind === "disc") {
            return (
              <div
                key={`disc-${row.disc}`}
                style={{ ...style, height: DISC_ROW_HEIGHT }}
                className="flex items-center gap-4 px-4 pt-3 font-bold text-subdued"
              >
                <Disc3 size={18} />
                <span>
                  {row.title
                    ? `${t("track.disc", { n: row.disc })} – ${row.title}`
                    : t("track.disc", { n: row.disc })}
                </span>
              </div>
            );
          }
          const selected = selection.has(row.index);
          const isCurrent = row.track.id === currentId;
          const menuTracks = selected && selectedTracks.length > 0 ? selectedTracks : [row.track];
          const menuIndices = selected && selectedTracks.length > 0 ? selectedIndices : [row.index];
          return (
            <div key={`${row.track.id}-${row.index}`} style={{ ...style, height: ROW_HEIGHT }}>
              <TrackMenu tracks={menuTracks} extra={menuExtra?.(menuTracks, menuIndices)}>
                <div>
                  <TrackRow
                    row={row}
                    number={useTrackNumbers ? (row.track.trackNumber ?? row.index + 1) : row.index + 1}
                    gridTemplate={gridTemplate}
                    showCover={showCover}
                    showAlbum={albumVisible}
                    added={addedAt?.(row.track, row.index)}
                    hasAdded={hasAdded}
                    selected={selected}
                    isCurrent={isCurrent}
                    isPlaying={isCurrent && playing}
                    onMouseDown={handleMouseDown}
                    onPlay={onPlay}
                  />
                </div>
              </TrackMenu>
            </div>
          );
        })}
      </div>
    </div>
  );
}
