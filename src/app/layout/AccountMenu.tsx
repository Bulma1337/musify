import { useState } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { AlertDialog, DropdownMenu } from "radix-ui";
import { Check, LogOut, Plus, Settings } from "lucide-react";
import type { ServerConfig } from "@/api/provider";
import { useSession } from "@/api/session";
import { menuContent, menuItem, menuSeparator } from "@/components/media/TrackMenu";
import { Button } from "@/components/ui/Button";
import { dialogContent, dialogOverlay } from "@/features/playlist/EditPlaylistDialog";
import { usePlayer } from "@/player/store";

/** "music.example.com" – the address without scheme (it never contains credentials). */
function hostOf(server: ServerConfig): string {
  try {
    return new URL(server.url).host;
  } catch {
    return server.url;
  }
}

/**
 * Account menu in the title bar: the connected server and user, switch between saved servers, add
 * one, settings, sign out of the current one.
 */
export function AccountMenu() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const servers = useSession((s) => s.servers);
  const activeId = useSession((s) => s.activeServerId);
  const offline = useSession((s) => s.offline);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const active = servers.find((s) => s.id === activeId);
  if (!active) return null;

  const initial = (active.username || active.name).trim().charAt(0).toUpperCase() || "?";

  function switchTo(id: string) {
    if (id === activeId) return;
    // Queued tracks belong to the old server and can't be played from the new one.
    usePlayer.getState().resetQueue();
    void useSession.getState().switchServer(id);
  }

  async function signOut() {
    if (!active) return;
    usePlayer.getState().resetQueue();
    await useSession.getState().removeServer(active.id);
  }

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label={t("account.menu")}
            title={`${active.username} · ${active.name}`}
            className="mx-1 grid size-8 shrink-0 place-items-center self-center rounded-full bg-accent text-sm font-bold text-on-accent outline-none hover:scale-105 focus-visible:ring-2 focus-visible:ring-text"
          >
            {initial}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={6} className={menuContent}>
            <div className="px-3 pt-2 pb-1.5">
              <p className="truncate font-bold">{active.username}</p>
              <p className="truncate text-xs text-subdued">
                {active.name} · {hostOf(active)}
                {offline && ` · ${t("account.offline")}`}
              </p>
            </div>
            <DropdownMenu.Separator className={menuSeparator} />
            <DropdownMenu.Label className="px-3 pt-1 pb-1 text-xs text-subdued">
              {t("account.servers")}
            </DropdownMenu.Label>
            {servers.map((server) => (
              <DropdownMenu.Item key={server.id} className={menuItem} onSelect={() => switchTo(server.id)}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{server.name}</span>
                  <span className="block truncate text-xs text-subdued">
                    {server.username} · {hostOf(server)}
                  </span>
                </span>
                {server.id === activeId && (
                  <Check size={16} className="shrink-0 text-accent" aria-label={t("account.current")} />
                )}
              </DropdownMenu.Item>
            ))}
            <DropdownMenu.Item className={menuItem} onSelect={() => useSession.getState().setAdding(true)}>
              <Plus size={16} /> {t("account.addServer")}
            </DropdownMenu.Item>
            <DropdownMenu.Separator className={menuSeparator} />
            <DropdownMenu.Item className={menuItem} onSelect={() => navigate("/settings")}>
              <Settings size={16} /> {t("settings.title")}
            </DropdownMenu.Item>
            <DropdownMenu.Item className={menuItem} onSelect={() => setConfirmSignOut(true)}>
              <LogOut size={16} />
              <span className="truncate">{t("account.signOut", { server: active.name })}</span>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <AlertDialog.Root open={confirmSignOut} onOpenChange={setConfirmSignOut}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={dialogOverlay} />
          <AlertDialog.Content className={dialogContent}>
            <AlertDialog.Title className="text-2xl font-bold tracking-tight">
              {t("account.signOutTitle", { server: active.name })}
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-3 text-subdued">
              {t("account.signOutBody")}
            </AlertDialog.Description>
            <div className="mt-6 flex justify-end gap-3">
              <AlertDialog.Cancel asChild>
                <Button variant="ghost">{t("account.cancel")}</Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button variant="danger" onClick={() => void signOut()}>
                  {t("account.signOutConfirm")}
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </>
  );
}
