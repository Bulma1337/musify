import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./styles/index.css";
import "./i18n";
import { App } from "./app/App";
import { useSession } from "./api/session";
import { useEngineStatus } from "./player/bridge";
import { usePlayer } from "./player/store";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Library data changes rarely; avoid refetch storms when switching windows.
      staleTime: 5 * 60_000,
      gcTime: 30 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

// Dev-only handle for scripts/tauri-e2e.mjs and debugging in the WebView DevTools.
if (import.meta.env.DEV) {
  Object.assign(window, { __navify: { usePlayer, useSession, useEngineStatus } });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
