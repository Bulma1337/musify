import { cn } from "@/lib/cn";
import { useToasts } from "./toast";

/** Renders the active toasts above the player bar. */
export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={cn(
            "animate-[toast-in_200ms_ease-out] rounded-lg px-4 py-2.5 text-sm font-semibold shadow-xl",
            t.tone === "error" ? "bg-danger text-black" : "bg-accent text-on-accent",
          )}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
