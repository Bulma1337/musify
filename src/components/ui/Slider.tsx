import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@/lib/cn";

export interface SliderProps {
  /** 0…1 */
  value: number;
  onChange: (value: number) => void;
  /** Called once when dragging ends (e.g. to seek only on release). */
  onCommit?: (value: number) => void;
  label: string;
  /** Text for screen readers, e.g. "1:23 von 3:45". */
  valueText?: string;
  className?: string;
  step?: number;
}

/**
 * Thin horizontal slider in the player style: white fill, accent fill and a thumb on hover/drag.
 * While dragging, the displayed value follows the pointer; `onChange` fires continuously.
 */
export function Slider({ value, onChange, onCommit, label, valueText, className, step = 0.01 }: SliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragValue, setDragValue] = useState<number | null>(null);
  const shown = Math.min(1, Math.max(0, dragValue ?? value));

  function valueAt(clientX: number): number {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return shown;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const v = valueAt(e.clientX);
    setDragValue(v);
    onChange(v);
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (dragValue === null) return;
    const v = valueAt(e.clientX);
    setDragValue(v);
    onChange(v);
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    if (dragValue === null) return;
    const v = valueAt(e.clientX);
    setDragValue(null);
    onCommit?.(v);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const delta =
      e.key === "ArrowRight" || e.key === "ArrowUp"
        ? step
        : e.key === "ArrowLeft" || e.key === "ArrowDown"
          ? -step
          : 0;
    if (delta === 0) return;
    e.preventDefault();
    const v = Math.min(1, Math.max(0, value + delta * (e.shiftKey ? 5 : 1)));
    onChange(v);
    onCommit?.(v);
  }

  const dragging = dragValue !== null;

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(shown * 100)}
      aria-valuetext={valueText}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDragValue(null)}
      onKeyDown={onKeyDown}
      className={cn("group relative flex h-4 cursor-pointer touch-none items-center outline-none", className)}
    >
      <div ref={trackRef} className="relative h-1 w-full overflow-hidden rounded-full bg-white/30">
        <div
          className={cn(
            "absolute inset-y-0 left-0 rounded-full",
            dragging ? "bg-accent" : "bg-text group-hover:bg-accent group-focus-visible:bg-accent",
          )}
          style={{ width: `${shown * 100}%` }}
        />
      </div>
      <div
        className={cn(
          "pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-text shadow",
          dragging ? "block" : "hidden group-hover:block group-focus-visible:block",
        )}
        style={{ left: `${shown * 100}%` }}
      />
    </div>
  );
}
