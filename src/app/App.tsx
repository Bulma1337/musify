import { useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { RouterProvider } from "react-router";
import { describeError } from "@/api/errors";
import { useSession } from "@/api/session";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { ConnectServer } from "@/features/onboarding/ConnectServer";
import { TitleBar } from "./layout/TitleBar";
import { router } from "./routes";

function StandaloneScreen({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <TitleBar minimal />
      {children}
    </div>
  );
}

function CenteredStatus({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-subdued">{children}</div>
  );
}

/** Application root: onboarding, connection status, or the routed main shell. */
export function App() {
  const { t } = useTranslation();
  const { status, error, servers, activeServerId, init, reconnect, removeServer } = useSession();
  const active = servers.find((s) => s.id === activeServerId);

  useEffect(() => {
    void init();
  }, [init]);

  if (status === "ready") return <RouterProvider router={router} />;

  if (status === "signedOut" || (status === "error" && error?.kind === "auth")) {
    return (
      <StandaloneScreen>
        <ConnectServer />
      </StandaloneScreen>
    );
  }

  if (status === "loading" || status === "connecting") {
    return (
      <StandaloneScreen>
        <CenteredStatus>
          <Spinner size={32} />
          {status === "connecting" && active && <p>{t("app.connecting", { server: active.name })}</p>}
        </CenteredStatus>
      </StandaloneScreen>
    );
  }

  return (
    <StandaloneScreen>
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
    </StandaloneScreen>
  );
}
