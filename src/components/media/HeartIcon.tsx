import { useState } from "react";
import { Heart } from "lucide-react";
import { cn } from "@/lib/cn";

/** Heart of the favorite buttons: filled when on, with a short pop and ring when it turns on. */
export function HeartIcon({
  filled,
  size,
  className,
}: {
  filled: boolean;
  size: number;
  className?: string;
}) {
  const [was, setWas] = useState(filled);
  const [pops, setPops] = useState(0);
  if (filled !== was) {
    setWas(filled);
    if (filled) setPops(pops + 1);
  }
  const popping = pops > 0 && filled;
  return (
    <span className="relative grid place-items-center">
      <Heart
        key={pops}
        size={size}
        className={cn(filled && "fill-current", popping && "animate-heart-pop", className)}
      />
      {popping && (
        <span
          key={`ring-${pops}`}
          aria-hidden="true"
          className="pointer-events-none absolute -inset-[45%] animate-heart-ring rounded-full border-2 border-accent opacity-0"
        />
      )}
    </span>
  );
}
