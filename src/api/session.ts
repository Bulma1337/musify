import { create } from "zustand";
import { createOfflineProvider } from "@/features/downloads/offlineProvider";
import { decorateProvider } from "@/features/downloads/providerHooks";
import { readPersisted, writePersisted } from "@/lib/persist";
import { setInsecureTls } from "./http";
import { ProviderError, type LoginResult, type MusicProvider, type ServerConfig } from "./provider";
import { factoryFor } from "./registry";
import { deleteSecret, loadSecret, saveSecret } from "./secrets";

const FILE = "servers.json";

type SessionStatus = "loading" | "signedOut" | "connecting" | "ready" | "offline" | "error";

interface SessionState {
  servers: ServerConfig[];
  activeServerId?: string;
  /** The server, or - in offline mode - a provider that serves the downloaded library only. */
  provider: MusicProvider | null;
  status: SessionStatus;
  error?: ProviderError;
  /** The server can't be reached: the app shows downloaded content only and keeps trying to reconnect. */
  offline: boolean;
  /** A reconnect attempt is running (offline mode). */
  reconnecting: boolean;

  /** Loads the saved servers and connects to the active one. Call once at startup. */
  init(): Promise<void>;
  /** Persists a freshly logged-in server, stores its secret and makes it active. */
  addServer(login: LoginResult): Promise<void>;
  switchServer(id: string): Promise<void>;
  removeServer(id: string): Promise<void>;
  /** Retries the connection to the active server (e.g. after the credentials were rejected). */
  reconnect(): Promise<void>;
  /** Offline mode: tries to reach the server right now instead of waiting for the next attempt. */
  retryNow(): Promise<void>;
  /** Pings the server after a failed request and switches to offline mode if it is really gone. */
  checkConnection(): Promise<void>;
}

/** Time between reconnect attempts in offline mode: 5 s, 10 s, 20 s, 40 s, then every minute. */
const RECONNECT_START_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;

async function persist(servers: ServerConfig[], activeServerId: string | undefined) {
  await writePersisted(FILE, "servers", servers);
  await writePersisted(FILE, "activeServerId", activeServerId ?? null);
}

const isUnreachable = (error: ProviderError) => error.kind === "network" || error.kind === "timeout";

function toProviderError(error: unknown): ProviderError {
  return error instanceof ProviderError
    ? error
    : new ProviderError("server", String(error), undefined, { cause: error });
}

async function secretFor(server: ServerConfig): Promise<string> {
  const secret = await loadSecret(server.id);
  if (!secret) throw new ProviderError("auth", "No stored credentials for this server");
  return secret;
}

export const useSession = create<SessionState>((set, get) => {
  /** The real connection behind the (decorated) provider, used for pings. */
  let connected: MusicProvider | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectDelay = RECONNECT_START_MS;
  let checking = false;

  function cancelReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    reconnectDelay = RECONNECT_START_MS;
  }

  /** Decorates a fresh connection: failed requests lead to a connection check. */
  function wrap(provider: MusicProvider): MusicProvider {
    connected = provider;
    return decorateProvider(provider, { onNetworkError: () => void get().checkConnection() });
  }

  async function enterOffline(server: ServerConfig) {
    cancelReconnect();
    connected = null;
    const provider = await createOfflineProvider(server);
    if (get().activeServerId !== server.id) return;
    set({ provider, status: "ready", error: undefined, offline: true, reconnecting: false });
    scheduleReconnect(server.id);
  }

  function scheduleReconnect(serverId: string) {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => void attemptReconnect(serverId), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  /** One reconnect attempt in offline mode. Resolves when it is over. */
  async function attemptReconnect(serverId: string) {
    const server = get().servers.find((s) => s.id === serverId);
    if (!server || get().activeServerId !== serverId || !get().offline || get().reconnecting) return;
    clearTimeout(reconnectTimer);
    set({ reconnecting: true });
    try {
      const provider = await factoryFor(server.kind).connect(server, await secretFor(server));
      if (get().activeServerId !== serverId) return;
      cancelReconnect();
      set({
        provider: wrap(provider),
        status: "ready",
        error: undefined,
        offline: false,
        reconnecting: false,
      });
    } catch (error) {
      if (get().activeServerId !== serverId) return;
      const providerError = toProviderError(error);
      if (isUnreachable(providerError)) {
        set({ reconnecting: false });
        scheduleReconnect(serverId);
      } else {
        // The server answers but refuses us (changed password …): back to the error/login screen.
        cancelReconnect();
        set({ provider: null, status: "error", error: providerError, offline: false, reconnecting: false });
      }
    }
  }

  async function connect(server: ServerConfig) {
    cancelReconnect();
    set({ status: "connecting", error: undefined, activeServerId: server.id, offline: false });
    setInsecureTls(server.url, server.allowInsecureTls ?? false);
    try {
      const provider = await factoryFor(server.kind).connect(server, await secretFor(server));
      if (get().activeServerId === server.id) set({ provider: wrap(provider), status: "ready" });
    } catch (error) {
      const providerError = toProviderError(error);
      if (isUnreachable(providerError)) await enterOffline(server);
      else set({ provider: null, status: "error", error: providerError });
    }
  }

  return {
    servers: [],
    provider: null,
    status: "loading",
    offline: false,
    reconnecting: false,

    async init() {
      const servers = (await readPersisted<ServerConfig[]>(FILE, "servers")) ?? [];
      const activeServerId = (await readPersisted<string | null>(FILE, "activeServerId")) ?? undefined;
      const active = servers.find((s) => s.id === activeServerId) ?? servers[0];
      set({ servers, activeServerId: active?.id });
      if (active) await connect(active);
      else set({ status: "signedOut" });
    },

    async addServer({ server, secret }) {
      await saveSecret(server.id, secret);
      const servers = [...get().servers.filter((s) => s.id !== server.id), server];
      set({ servers });
      await persist(servers, server.id);
      await connect(server);
    },

    async switchServer(id) {
      const server = get().servers.find((s) => s.id === id);
      if (!server) return;
      await persist(get().servers, id);
      await connect(server);
    },

    async removeServer(id) {
      await deleteSecret(id);
      const servers = get().servers.filter((s) => s.id !== id);
      const wasActive = get().activeServerId === id;
      const next = wasActive ? servers[0] : get().servers.find((s) => s.id === get().activeServerId);
      if (wasActive) cancelReconnect();
      set({ servers, ...(wasActive ? { provider: null, offline: false } : {}) });
      await persist(servers, next?.id);
      if (!wasActive) return;
      if (next) await connect(next);
      else set({ status: "signedOut", activeServerId: undefined });
    },

    async reconnect() {
      const server = get().servers.find((s) => s.id === get().activeServerId);
      if (server) await connect(server);
    },

    async retryNow() {
      const id = get().activeServerId;
      if (id) await attemptReconnect(id);
    },

    async checkConnection() {
      const server = get().servers.find((s) => s.id === get().activeServerId);
      const provider = connected;
      if (!server || !provider || get().offline || checking) return;
      checking = true;
      try {
        await provider.ping();
      } catch (error) {
        // Only a failing ping proves the server is gone; a single failed request may be a hiccup.
        if (provider === connected && !get().offline && isUnreachable(toProviderError(error))) {
          await enterOffline(server);
        }
      } finally {
        checking = false;
      }
    },
  };
});

/** True in offline mode (server unreachable, downloaded content only). */
export function useIsOffline(): boolean {
  return useSession((s) => s.offline);
}

/** The connected provider. Only call inside screens that render when `status === "ready"`. */
export function useProvider(): MusicProvider {
  const provider = useSession((s) => s.provider);
  if (!provider) throw new Error("useProvider() called without a connected server");
  return provider;
}
