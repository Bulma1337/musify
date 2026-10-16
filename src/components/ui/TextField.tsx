import { useId, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  label: string;
  /** Helper or status text below the field. */
  hint?: ReactNode;
  error?: string;
  /** Adds a show/hide toggle for password fields. */
  revealable?: boolean;
}

export function TextField({
  label,
  hint,
  error,
  revealable,
  type = "text",
  className,
  id,
  ...rest
}: TextFieldProps) {
  const { t } = useTranslation();
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const [revealed, setRevealed] = useState(false);
  const effectiveType = revealable && revealed ? "text" : type;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <label htmlFor={inputId} className="text-sm font-bold">
        {label}
      </label>
      <div className="relative">
        <input
          id={inputId}
          type={effectiveType}
          aria-invalid={error ? true : undefined}
          className={cn(
            "h-12 w-full rounded-md border bg-surface px-3.5 text-[15px] text-text outline-none transition-colors placeholder:text-muted",
            "hover:border-subdued focus:border-text focus:shadow-[0_0_0_1px_var(--color-text)]",
            error ? "border-danger" : "border-muted",
            revealable && "pr-12",
          )}
          {...rest}
        />
        {revealable && (
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            aria-label={revealed ? t("common.hidePassword") : t("common.showPassword")}
            className="absolute inset-y-0 right-0 grid w-12 place-items-center text-subdued hover:text-text"
          >
            {revealed ? <EyeOff size={20} /> : <Eye size={20} />}
          </button>
        )}
      </div>
      {error ? (
        <p className="text-[13px] text-danger">{error}</p>
      ) : hint ? (
        <div className="text-[13px] text-subdued">{hint}</div>
      ) : null}
    </div>
  );
}
