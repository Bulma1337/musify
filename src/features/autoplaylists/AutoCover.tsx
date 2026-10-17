import { CalendarDays, Flame, History, Trophy, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import type { AutoRef } from "./autoPlaylists";

const LOOK: Record<AutoRef["kind"], { icon: LucideIcon; gradient: string; ink: string }> = {
  heavyRotation: { icon: Flame, gradient: "from-warning to-danger", ink: "text-black/75" },
  rediscovered: { icon: History, gradient: "from-accent-hover to-accent-press", ink: "text-white" },
  allTime: { icon: Trophy, gradient: "from-accent to-backdrop", ink: "text-white" },
  topYear: {
    icon: CalendarDays,
    gradient: "from-accent-press via-accent to-accent-hover",
    ink: "text-white",
  },
};

/** Generated cover for an automatic playlist (they have no server-side artwork). */
export function AutoCover({ auto, className }: { auto: AutoRef; className?: string }) {
  const { icon: Icon, gradient, ink } = LOOK[auto.kind];
  return (
    <div
      className={cn("relative grid size-full place-items-center bg-gradient-to-br", gradient, ink, className)}
      aria-hidden
    >
      <Icon style={{ width: "38%", height: "38%" }} strokeWidth={1.5} />
      {auto.kind === "topYear" && (
        <span className="absolute inset-x-0 bottom-[10%] text-center text-[clamp(14px,14cqw,40px)] font-extrabold tracking-tight">
          {auto.year}
        </span>
      )}
    </div>
  );
}
