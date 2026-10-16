import i18n from "@/i18n";

/** "3:07", "1:02:45" */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = s.toString().padStart(2, "0");
  return h > 0 ? `${h}:${m.toString().padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Long form for headers: "54 Min. 19 Sek.", "6 Std. 14 Min." */
export function formatLongDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return i18n.t("format.hoursMinutes", { h, m });
  return i18n.t("format.minutesSeconds", { m, s });
}

/** "13. März 2024" / "Mar 13, 2024" */
export function formatDate(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(i18n.language, { day: "numeric", month: "long", year: "numeric" }).format(
    date,
  );
}

/** "vor 3 Tagen" for recent dates, otherwise the full date. */
export function formatRelativeDate(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  const diffDays = Math.round((Date.now() - date.getTime()) / 86_400_000);
  if (diffDays < 0 || diffDays > 30) return formatDate(iso);
  const rtf = new Intl.RelativeTimeFormat(i18n.language, { numeric: "auto" });
  if (diffDays === 0) {
    const hours = Math.round((Date.now() - date.getTime()) / 3_600_000);
    return hours < 1 ? rtf.format(0, "minute") : rtf.format(-hours, "hour");
  }
  return rtf.format(-diffDays, "day");
}

/** "1.234" / "1,234" */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat(i18n.language).format(value);
}
