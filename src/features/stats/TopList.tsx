import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Play } from "lucide-react";
import { Cover } from "@/components/media/Cover";
import { IconButton } from "@/components/ui/Button";
import { formatNumber } from "@/lib/format";
import type { StatRow } from "./history";

export type TopKind = "track" | "artist" | "album" | "genre";

const COLLAPSED = 5;

function linkFor(kind: TopKind, row: StatRow): string | undefined {
  switch (kind) {
    case "artist":
      return row.id ? `/artist/${row.id}` : undefined;
    case "album":
      return row.id ? `/album/${row.id}` : undefined;
    case "genre":
      return `/genre/${encodeURIComponent(row.title)}`;
    case "track":
      return row.albumId ? `/album/${row.albumId}` : undefined;
  }
}

export interface TopListProps {
  title: string;
  kind: TopKind;
  rows: StatRow[];
  /** Plays the row; the play button is hidden without it. */
  onPlay?: (row: StatRow) => void;
}

/** A ranked list (songs, artists, albums or genres) with covers, play counts and a play button. */
export function TopList({ title, kind, rows, onPlay }: TopListProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? rows : rows.slice(0, COLLAPSED);

  return (
    <section className="min-w-0 rounded-lg bg-elevated p-4" aria-label={title}>
      <div className="mb-2 flex items-baseline justify-between gap-3 px-2">
        <h3 className="text-lg font-bold tracking-tight">{title}</h3>
        {rows.length > 0 && <span className="text-xs text-subdued">{t("stats.plays")}</span>}
      </div>
      {rows.length === 0 ? (
        <p className="px-2 py-4 text-sm text-subdued">{t("stats.noData")}</p>
      ) : (
        <ol>
          {visible.map((row, index) => {
            const to = linkFor(kind, row);
            const subtitle = kind === "track" || kind === "album" ? row.artist : null;
            return (
              <li
                key={`${row.id ?? row.title}-${index}`}
                className="group flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-highlight"
              >
                <span className="w-5 shrink-0 text-right text-sm text-subdued tabular-nums">{index + 1}</span>
                {kind !== "genre" && (
                  <Cover
                    cover={row.cover ?? undefined}
                    size={40}
                    round={kind === "artist"}
                    fallback={kind === "artist" ? "artist" : kind === "track" ? "track" : "album"}
                    className="size-10 shadow-none"
                  />
                )}
                <div className="min-w-0 flex-1">
                  {to ? (
                    <Link to={to} className="block truncate font-medium hover:underline" title={row.title}>
                      {row.title}
                    </Link>
                  ) : (
                    <p className="truncate font-medium" title={row.title}>
                      {row.title}
                    </p>
                  )}
                  {subtitle && <p className="truncate text-sm text-subdued">{subtitle}</p>}
                </div>
                <span
                  className="shrink-0 text-sm text-subdued tabular-nums"
                  title={t("stats.playsCount", { count: row.plays })}
                >
                  {formatNumber(row.plays)}
                </span>
                {onPlay && (
                  <IconButton
                    label={t("stats.playRow", { title: row.title })}
                    size={32}
                    onClick={() => onPlay(row)}
                    className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <Play size={16} fill="currentColor" />
                  </IconButton>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {rows.length > COLLAPSED && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="mt-2 px-2 text-sm font-bold text-subdued hover:text-text"
        >
          {expanded ? t("stats.showLess") : t("stats.showMore")}
        </button>
      )}
    </section>
  );
}
