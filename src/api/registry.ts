import { normalizeServerUrl } from "./http";
import { ProviderError, type ProviderFactory, type ServerKind, type ServerProbe } from "./provider";
import { subsonicFactory } from "./subsonic";

/** All available server adapters. Probe order matters: the first match wins. */
export const providerFactories: ProviderFactory[] = [subsonicFactory];

export function factoryFor(kind: ServerKind): ProviderFactory {
  const factory = providerFactories.find((f) => f.kind === kind);
  if (!factory) throw new ProviderError("unsupported", `No adapter for server type "${kind}"`);
  return factory;
}

/**
 * Detects which kind of server answers at the given address. Tries https first when the user typed
 * no scheme, then http (common for servers in the home network).
 */
export async function detectServer(input: string): Promise<ServerProbe> {
  const hasScheme = /^https?:\/\//i.test(input.trim());
  const candidates = hasScheme
    ? [normalizeServerUrl(input)]
    : [normalizeServerUrl(`https://${input.trim()}`), normalizeServerUrl(`http://${input.trim()}`)];

  let lastError: unknown;
  for (const url of candidates) {
    for (const factory of providerFactories) {
      try {
        const probe = await factory.probe(url);
        if (probe) return probe;
      } catch (error) {
        lastError = error;
      }
    }
  }
  if (lastError instanceof ProviderError && lastError.kind !== "notFound") throw lastError;
  throw new ProviderError("notFound", "No supported music server found at this address");
}
