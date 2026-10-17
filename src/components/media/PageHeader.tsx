import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CoverRef } from "@/api/provider";
import { useScrollContainer } from "@/app/layout/scrollContainer";
import { cn } from "@/lib/cn";
import { rgbCss, type Rgb } from "@/lib/color";
import { Cover } from "./Cover";
import { PlayButton } from "./PlayButton";
import { useCoverColor } from "./useCoverColor";

function titleSize(title: string): string {
  if (title.length <= 16) return "text-[clamp(2rem,7cqw,6rem)]";
  if (title.length <= 32) return "text-[clamp(2rem,5.5cqw,4.5rem)]";
  if (title.length <= 60) return "text-[clamp(1.75rem,4cqw,3rem)]";
  return "text-[clamp(1.5rem,3cqw,2rem)]";
}

export interface PageHeaderProps {
  /** "Album", "Playlist", "Künstler" … */
  kind: string;
  title: string;
  cover?: CoverRef;
  coverFallback?: "album" | "playlist" | "artist" | "liked";
  /** Custom artwork (generated covers); replaces the cover image. */
  art?: ReactNode;
  round?: boolean;
  /** Line below the title: owner/artist, year, track count, duration. */
  meta?: ReactNode;
  description?: ReactNode;
  /** Header color; derived from the cover when omitted. */
  color?: Rgb;
  playing: boolean;
  onPlay: () => void;
  /** Buttons next to the play button (shuffle, like, download, …). */
  actions?: ReactNode;
  /** Shown next to the title (e.g. a pencil to edit the details). */
  titleAction?: ReactNode;
  /** Makes the cover a button (e.g. to change a playlist's image); shows the label on hover. */
  coverAction?: { label: string; icon: ReactNode; onClick: () => void };
}

/**
 * Colored page header with big cover and title, the action row below it, and a compact sticky bar
 * (color + play button + title) that appears once the header scrolls out of view.
 */
export function PageHeader(props: PageHeaderProps) {
  const { kind, title, cover, coverFallback, art, round, meta, description, playing, onPlay, actions } =
    props;
  const { titleAction, coverAction } = props;
  const derived = useCoverColor(props.color ? undefined : cover);
  const color = props.color ?? derived;
  const scrollElement = useScrollContainer();
  const sentinel = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const element = sentinel.current;
    if (!element || !scrollElement) return;
    const observer = new IntersectionObserver(([entry]) => setCompact(!entry?.isIntersecting), {
      root: scrollElement,
      rootMargin: "-64px 0px 0px 0px",
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [scrollElement]);

  return (
    <>
      <div
        className={cn(
          "sticky top-0 z-20 -mb-16 flex h-16 items-center gap-3 px-6 transition-opacity duration-200",
          compact ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        style={{ backgroundColor: rgbCss({ r: color.r * 0.6, g: color.g * 0.6, b: color.b * 0.6 }) }}
      >
        <PlayButton playing={playing} onClick={onPlay} size={44} />
        <span className="truncate text-2xl font-bold">{title}</span>
      </div>

      <header
        className="@container flex items-end gap-6 px-6 pt-20 pb-6"
        style={{ background: `linear-gradient(${rgbCss(color)}, ${rgbCss(color, 0.55)})` }}
      >
        {art ? (
          <div className="aspect-square w-[clamp(128px,22cqw,232px)] shrink-0 overflow-hidden rounded-[4px] shadow-[0_4px_60px_rgb(0_0_0/0.5)]">
            {art}
          </div>
        ) : (
          <div className="group/cover relative shrink-0">
            <Cover
              cover={cover}
              size={232}
              round={round}
              fallback={coverFallback}
              eager
              className="w-[clamp(128px,22cqw,232px)] shadow-[0_4px_60px_rgb(0_0_0/0.5)]"
            />
            {coverAction && (
              <button
                type="button"
                onClick={coverAction.onClick}
                className={cn(
                  "absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 text-sm font-bold opacity-0 transition-opacity duration-150 group-hover/cover:opacity-100 focus-visible:opacity-100",
                  round ? "rounded-full" : "rounded-[4px]",
                )}
              >
                {coverAction.icon}
                {coverAction.label}
              </button>
            )}
          </div>
        )}
        <div className="flex min-w-0 flex-col gap-2">
          <span className="text-sm font-semibold">{kind}</span>
          <div className="group/title flex min-w-0 items-end gap-3">
            <h1
              className={cn(
                "line-clamp-3 min-w-0 font-extrabold leading-[1.05] tracking-tight break-words",
                titleSize(title),
              )}
            >
              {title}
            </h1>
            {titleAction && (
              <div className="mb-[0.4em] shrink-0 opacity-60 transition-opacity group-hover/title:opacity-100 focus-within:opacity-100">
                {titleAction}
              </div>
            )}
          </div>
          {description && <div className="line-clamp-2 text-sm text-subdued">{description}</div>}
          {meta && <div className="flex flex-wrap items-center gap-x-1 text-sm">{meta}</div>}
        </div>
      </header>
      <div ref={sentinel} />

      <div style={{ background: `linear-gradient(${rgbCss(color, 0.35)}, transparent 232px)` }}>
        <div className="flex items-center gap-6 px-6 py-6">
          <PlayButton playing={playing} onClick={onPlay} />
          {actions}
        </div>
      </div>
    </>
  );
}
