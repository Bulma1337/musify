import { cn } from "@/lib/cn";

/** Small circular loading indicator that inherits the current text color. */
export function Spinner({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      role="status"
      aria-label="Loading"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cn("animate-spin", className)}
    >
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path
        d="M22 12a10 10 0 0 0-10-10"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
