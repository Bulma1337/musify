import { useTranslation } from "react-i18next";
import { WifiOff } from "lucide-react";
import { useSession } from "@/api/session";
import { Button } from "@/components/ui/Button";

/** Shown above the main view while the server can't be reached; reconnecting happens automatically. */
export function OfflineBanner() {
  const { t } = useTranslation();
  const offline = useSession((s) => s.offline);
  const reconnecting = useSession((s) => s.reconnecting);
  const retryNow = useSession((s) => s.retryNow);
  if (!offline) return null;
  return (
    <div
      role="status"
      className="mx-2 mb-2 flex shrink-0 items-center gap-3 rounded-lg bg-warning/15 px-4 py-2 text-sm text-text"
    >
      <WifiOff size={18} className="shrink-0 text-warning" aria-hidden />
      <p className="min-w-0 flex-1">{t("downloads.offline.banner")}</p>
      <Button variant="secondary" size="sm" loading={reconnecting} onClick={() => void retryNow()}>
        {reconnecting ? t("downloads.offline.reconnecting") : t("downloads.offline.reconnect")}
      </Button>
    </div>
  );
}
