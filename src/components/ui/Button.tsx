import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Spinner } from "./Spinner";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const variants: Record<Variant, string> = {
  primary:
    "bg-accent accent-fill text-on-accent hover:bg-accent-hover hover:brightness-110 active:bg-accent-press active:scale-[0.97] hover:scale-[1.03]",
  secondary: "border border-muted text-text hover:border-text hover:scale-[1.03] active:scale-[0.97]",
  ghost: "text-subdued hover:text-text",
  danger: "bg-danger text-black hover:brightness-110",
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-4 text-[13px]",
  md: "h-10 px-6 text-sm",
  lg: "h-12 px-8 text-base",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

/** Pill-shaped button in the app's visual language. */
export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  icon,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-2 rounded-full font-bold transition-[transform,background-color,border-color,color,filter] duration-150 disabled:pointer-events-none disabled:opacity-50",
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={16} /> : icon}
      {children}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name, also used as tooltip text. */
  label: string;
  size?: number;
  active?: boolean;
}

/** Round icon-only button (player controls, toolbar actions). */
export function IconButton({
  label,
  size = 32,
  active,
  className,
  children,
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      style={{ width: size, height: size }}
      className={cn(
        "grid shrink-0 place-items-center rounded-full transition-[transform,color] duration-150 hover:scale-105 active:scale-90 disabled:pointer-events-none disabled:opacity-40",
        active ? "text-accent hover:text-accent-hover" : "text-subdued hover:text-text",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
