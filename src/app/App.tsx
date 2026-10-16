import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { describeError } from "@/api/errors";
import { useProvider, useSession } from "@/api/session";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { ConnectServer } from "@/features/onboarding/ConnectServer";
import { TitleBar } from "./layout/TitleBar";

/** Temporary connection check until the real home view lands in milestone 2. */
function RecentlyAdded() {
  const provider = useProvider();
  const { data, isPending, error } = useQuery({
    queryKey: [provider.server.id, "albums", "recentlyAdded"],
    queryFn: () => provider.getAlbumList("recentlyAdded", { size: 12 }),
  });
  const { t } = useTranslation();

  if (isPending) return <Spinner className="mt-6 text-subdued" />;
  if (error) return <p className="mt-6 text-danger">{describeError(t, error)}</p>;
  return (
    <div className="mt-8 grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-6">
      {data.map((album) => (
        <div key={album.id} className="rounded-md p-3 transition-colors hover:bg-highlight">
          {album.cover && (
            <img
              src={provider.coverUrl(album.cover, 300)}
              alt=""
              loading="lazy"
              className="aspect-square w-full rounded-md object-cover shadow-lg"
            />
          )}
          <p className="mt-2 truncate font-bold">{album.name}</p>
          <p className="truncate text-sm text-subdued">{album.artistLine}</p>
        </div>
      ))}
    </div>
  );
}

function MainShell() {
  const { t } = useTranslation();
  const provider = useProvider();

  return (
    <div className="flex min-h-0 flex-1 gap-2 px-2">
      <aside className="w-[300px] shrink-0 rounded-lg bg-surface p-4">
        <h2 className="font-bold">{t("library.title")}</h2>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto rounded-lg bg-surface bg-gradient-to-b from-accent-soft to-surface to-40% p-6">
        <h1 className="text-5xl font-extrabold tracking-tight">{t("app.name")}</h1>
        <p className="mt-2 text-subdued">{provider.server.name}</p>
        <RecentlyAdded />
      </main>
      <aside className="hidden w-[320px] shrink-0 rounded-lg bg-surface p-4 xl:block">
        <p className="text-subdued">{t("nowPlaying.nothing")}</p>
      </aside>
    </div>
  );
}

function CenteredStatus({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-subdued">{children}</div>
  );
}

/** Application root: picks onboarding, connection status or the main shell from the session state. */
export function App() {
  const { t } = useTranslation();
  const { status, error, servers, activeServerId, init, reconnect, removeServer } = useSession();
  const active = servers.find((s) => s.id === activeServerId);

  useEffect(() => {
    void init();
  }, [init]);

  let content: React.ReactNode;
  if (status === "ready") {
    content = <MainShell />;
  } else if (status === "signedOut" || (status === "error" && error?.kind === "auth")) {
    content = <ConnectServer />;
  } else if (status === "loading" || status === "connecting") {
    content = (
      <CenteredStatus>
        <Spinner size={32} />
        {status === "connecting" && active && <p>{t("app.connecting", { server: active.name })}</p>}
      </CenteredStatus>
    );
  } else {
    content = (
      <CenteredStatus>
        <p className="max-w-md text-center text-text">{describeError(t, error)}</p>
        <div className="flex gap-3">
          <Button onClick={() => void reconnect()}>{t("app.retry")}</Button>
          {active && (
            <Button variant="secondary" onClick={() => void removeServer(active.id)}>
              {t("app.signOut")}
            </Button>
          )}
        </div>
      </CenteredStatus>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      {content}
      <footer className="h-[72px] shrink-0" />
    </div>
  );
}
