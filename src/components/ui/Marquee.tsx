import { useCallback, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Pixels per second while the text moves. */
const SPEED = 30;
/** Width of the soft right edge, and the gap at the end so the last letter stops clear of it. */
const END_GAP = 24;

/**
 * One line of text that slowly moves to its end and back when it does not fit (no ellipsis).
 * Text that fits stays still.
 */
export function Marquee({ children, className }: { children: ReactNode; className?: string }) {
  const [overflow, setOverflow] = useState(0);
  const innerRef = useRef<HTMLSpanElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  const outerRef = useCallback((outer: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    if (!outer) return;
    const measure = () => {
      const inner = innerRef.current;
      if (inner) setOverflow(Math.max(0, inner.scrollWidth - outer.clientWidth));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    if (innerRef.current) observer.observe(innerRef.current);
    observerRef.current = observer;
  }, []);

  const moving = overflow > 1;
  const distance = overflow + END_GAP;
  const style = moving
    ? ({
        "--marquee-shift": `-${distance}px`,
        // Moving takes a third of the cycle each way; the rest are pauses at both ends.
        "--marquee-duration": `${Math.max(6, (distance / SPEED) * 3)}s`,
      } as CSSProperties)
    : undefined;

  return (
    <div
      ref={outerRef}
      className={cn(
        "overflow-hidden whitespace-nowrap",
        // Soft edges while moving: the right one always, the left one only while the start of the text
        // is moved out (animated in step with the text), so no letter is ever cut off hard.
        moving &&
          "animate-marquee-edge [mask-image:linear-gradient(90deg,transparent,black_var(--marquee-fade),black_calc(100%-24px),transparent)]",
        className,
      )}
      style={style}
    >
      <span ref={innerRef} className={cn("inline-block", moving && "animate-marquee")}>
        {children}
      </span>
    </div>
  );
}
