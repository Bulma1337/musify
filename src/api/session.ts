import { create } from "zustand";
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
  provider: MusicProvider | null;
  status: SessionStatus;
  error?: ProviderError;

  /** Loads the saved servers and connects to the active one. Call once at startup. */
  init(): Promise<void>;
  /** Persists a freshly logged-in server, stores its secret and makes it active. */
  addServer(login: LoginResult): Promise<void>;
  switchServer(id: string): Promise<void>;
  removeServer(id: string): Promise<void>;
  /** Retries the connection to the active server (e.g. after going offline). */
  reconnect(): Promise<void>;
}

async function persist(servers: ServerConfig[], activeServerId: string | undefined) {
  await writePersisted(FILE, "servers", servers);
  await writePersisted(FILE, "activeServerId", activeServerId ?? null);
}

export const useSession = create<SessionState>((set, get) => {
  async function connect(server: ServerConfig) {
    set({ status: "connecting", error: undefined, activeServerId: server.id });
    setInsecureTls(server.url, server.allowInsecureTls ?? false);
    try {
      const secret = await loadSecret(server.id);
      if (!secret) throw new ProviderError("auth", "No stored credentials for this server");
      const provider = await factoryFor(server.kind).connect(server, secret);
      if (get().activeServerId === server.id) set({ provider, status: "ready" });
    } catch (error) {
      const providerError =
        error instanceof ProviderError
          ? error
          : new ProviderError("server", String(error), undefined, { cause: error });
      const offline = providerError.kind === "network" || providerError.kind === "timeout";
      set({ provider: null, status: offline ? "offline" : "error", error: providerError });
    }
  }

  return {
    servers: [],
    provider: null,
    status: "loading",

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
      set({ servers, ...(wasActive ? { provider: null } : {}) });
      await persist(servers, next?.id);
      if (!wasActive) return;
      if (next) await connect(next);
      else set({ status: "signedOut", activeServerId: undefined });
    },

    async reconnect() {
      const server = get().servers.find((s) => s.id === get().activeServerId);
      if (server) await connect(server);
    },
  };
});

/** The connected provider. Only call inside screens that render when `status === "ready"`. */
export function useProvider(): MusicProvider {
  const provider = useSession((s) => s.provider);
  if (!provider) throw new Error("useProvider() called without a connected server");
  return provider;
}
