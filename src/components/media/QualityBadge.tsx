import { cn } from "@/lib/cn";

const BASE =
  "inline-flex shrink-0 items-center gap-1 rounded-[4px] bg-black/60 px-1.5 py-px text-[11px] leading-4 font-bold tracking-wide text-white ring-1 ring-white/15 backdrop-blur-sm";

/** Lossless sources get a small accent mark; the label itself is white on dark, so any background works. */
function Mark({ lossless }: { lossless: boolean }) {
  if (!lossless) return null;
  return <span aria-hidden="true" className="size-1.5 rounded-full bg-accent accent-fill" />;
}

/** "FLAC 24/96" and the like, readable on every header color. */
export function QualityBadge({
  label,
  lossless,
  className,
}: {
  label: string;
  lossless: boolean;
  className?: string;
}) {
  return (
    <span className={cn(BASE, className)}>
      <Mark lossless={lossless} />
      {label}
    </span>
  );
}
