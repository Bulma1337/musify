import { useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { ContextMenu } from "radix-ui";
import { ListX, Sparkles, X } from "lucide-react";
import { Cover } from "@/components/media/Cover";
import { menuItem, menuSeparator, TrackMenu } from "@/components/media/TrackMenu";
import { cn } from "@/lib/cn";
import { currentDraggedTracks, currentTrackDrag, endTrackDrag, isTrackDrag, startTrackDrag } from "@/lib/dnd";
import { formatDuration } from "@/lib/format";
import { upcomingContextItems, usePlayer, type QueueItem } from "@/player/store";

type Section = "manual" | "upcoming";

/** Rendered rows per section; very long contexts show a count instead of thousands of rows. */
const MAX_ROWS = 150;

interface RowProps {
  item: QueueItem;
  index: number;
  section?: Section;
  current?: boolean;
  dropBefore: boolean;
  onDragStart?: (e: DragEvent, index: number) => void;
  onDragOver?: (e: DragEvent, index: number) => void;
  onDrop?: (e: DragEvent) => void;
}

function QueueRow({ item, index, section, current, dropBefore, onDragStart, onDragOver, onDrop }: RowProps) {
  const { t } = useTranslation();
  const track = item.track;
  return (
    <TrackMenu
      tracks={[track]}
      extra={
        section ? (
          <>
            <ContextMenu.Separator className={menuSeparator} />
            <ContextMenu.Item
              className={menuItem}
              onSelect={() => usePlayer.getState().removeFromQueue([item.key])}
            >
              <ListX size={16} /> {t("queue.remove")}
            </ContextMenu.Item>
          </>
        ) : undefined
      }
    >
      <div
        role="listitem"
        draggable={!!section}
        onDragStart={(e) => onDragStart?.(e, index)}
        onDragOver={(e) => onDragOver?.(e, index)}
        onDrop={onDrop}
        onDragEnd={endTrackDrag}
        onDoubleClick={() => !current && usePlayer.getState().jumpTo(item.key)}
        className={cn(
          "group relative flex items-center gap-3 rounded-md p-2 hover:bg-highlight",
          dropBefore &&
            "before:absolute before:-top-px before:right-2 before:left-2 before:h-0.5 before:bg-accent",
        )}
      >
        <Cover cover={track.cover} size={48} fallback="track" className="w-12 shadow-none" />
        <div className="min-w-0 flex-1">
          <p className={cn("truncate", current && "text-accent")}>{track.title}</p>
          <p className="flex items-center gap-1.5 truncate text-sm text-subdued">
            {item.recommended && (
              <span
                className="flex shrink-0 items-center gap-0.5 text-xs text-accent"
                title={t("player.recommended")}
              >
                <Sparkles size={12} />
              </span>
            )}
            <span className="truncate">{track.artistLine}</span>
          </p>
        </div>
        {section ? (
          <button
            type="button"
            aria-label={t("queue.remove")}
            onClick={() => usePlayer.getState().removeFromQueue([item.key])}
            className="invisible text-subdued group-hover:visible hover:text-text"
          >
            <X size={16} />
          </button>
        ) : null}
        <span className="w-10 text-right text-sm text-subdued tabular-nums">
          {formatDuration(track.durationMs)}
        </span>
      </div>
    </TrackMenu>
  );
}

/** One reorderable section of the queue. Accepts drops of tracks from lists (adds them here). */
function QueueSection({
  section,
  title,
  items,
  action,
}: {
  section: Section;
  title: string;
  items: QueueItem[];
  action?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const origin = `queue:${section}`;

  function onDragStart(e: DragEvent, index: number) {
    const item = items[index];
    if (!item) return;
    startTrackDrag(e, { trackIds: [item.track.id], origin, indices: [index] }, item.track.title, [
      item.track,
    ]);
  }

  function onDragOver(e: DragEvent, index: number) {
    if (!isTrackDrag(e)) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    setDropIndex(e.clientY > rect.top + rect.height / 2 ? index + 1 : index);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    const drag = currentTrackDrag();
    const to = dropIndex ?? items.length;
    setDropIndex(null);
    const player = usePlayer.getState();
    if (drag?.origin === origin) {
      if (section === "manual") player.moveManual(drag.indices, to);
      else player.moveUpcoming(drag.indices, to);
    } else if (section === "manual") {
      // Tracks dragged in from a list: queue them at the drop position.
      const tracks = currentDraggedTracks();
      if (tracks.length > 0) {
        const before = player.manualQueue.length;
        player.addToQueue(tracks);
        player.moveManual(
          Array.from({ length: tracks.length }, (_, i) => before + i),
          to,
        );
      }
    }
    endTrackDrag();
  }

  if (items.length === 0 && section === "upcoming") return null;
  return (
    <section
      onDragOver={(e) => {
        if (isTrackDrag(e)) e.preventDefault();
      }}
      onDrop={onDrop}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropIndex(null);
      }}
    >
      <div className="flex items-center justify-between gap-2 px-2 pt-4 pb-1">
        <h3 className="truncate font-bold">{title}</h3>
        {action}
      </div>
      <div role="list">
        {items.slice(0, MAX_ROWS).map((item, index) => (
          <QueueRow
            key={item.key}
            item={item}
            index={index}
            section={section}
            dropBefore={dropIndex === index}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDrop={onDrop}
          />
        ))}
        {dropIndex !== null && dropIndex >= Math.min(items.length, MAX_ROWS) && (
          <div className="mx-2 h-0.5 rounded-full bg-accent" />
        )}
        {items.length > MAX_ROWS && (
          <p className="px-2 py-2 text-sm text-subdued">
            {t("queue.more", { count: items.length - MAX_ROWS })}
          </p>
        )}
        {items.length === 0 && section === "manual" && (
          <p className="mx-2 rounded-md border border-dashed border-divider px-3 py-3 text-sm text-subdued">
            {t("queue.dropHint")}
          </p>
        )}
      </div>
    </section>
  );
}

/** Queue tab of the right panel: now playing, user-queued items, what follows from the context. */
export function QueueView() {
  const { t } = useTranslation();
  const current = usePlayer((s) => s.current);
  const manual = usePlayer((s) => s.manualQueue);
  const context = usePlayer((s) => s.context);
  const upcoming = usePlayer(upcomingContextItems);

  if (!current) return <p className="px-2 pt-2 text-sm text-subdued">{t("queue.empty")}</p>;

  return (
    <>
      <section>
        <h3 className="px-2 pt-2 pb-1 font-bold">{t("queue.nowPlaying")}</h3>
        <QueueRow item={current} index={0} current dropBefore={false} />
      </section>
      <QueueSection
        section="manual"
        title={t("queue.nextInQueue")}
        items={manual}
        action={
          manual.length > 0 ? (
            <button
              type="button"
              onClick={() => usePlayer.getState().clearManualQueue()}
              className="shrink-0 text-sm font-bold text-subdued hover:text-text"
            >
              {t("queue.clear")}
            </button>
          ) : undefined
        }
      />
      <QueueSection
        section="upcoming"
        title={t("queue.nextFrom", { name: context?.name ?? "" })}
        items={upcoming}
      />
    </>
  );
}

/** "Zuletzt gehört" tab. */
export function HistoryView() {
  const { t } = useTranslation();
  const history = usePlayer((s) => s.history);
  if (history.length === 0)
    return <p className="px-2 pt-2 text-sm text-subdued">{t("queue.historyEmpty")}</p>;
  return (
    <div role="list">
      {history.map((item, index) => (
        <QueueRow key={`${item.key}-${index}`} item={item} index={index} dropBefore={false} />
      ))}
    </div>
  );
}
