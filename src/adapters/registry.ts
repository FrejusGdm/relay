// Finds the adapter of a provider (add-provider-adapters, design decision 1). Tests pass overrides,
// such as the in-process fake adapter; the production registry has no fake.
import { PROVIDERS } from "./providers";
import type { ProviderAdapter, ProviderId } from "./types";

export interface AdapterRegistry {
  providers(): ProviderId[];
  get(provider: ProviderId): ProviderAdapter;
}

// The Claude Code and Codex adapters are built by later tasks of add-provider-adapters (5.3, 7
// and 8). Until then, asking for one fails with this message.
const DEFAULT_ADAPTERS: Record<ProviderId, () => ProviderAdapter> = {
  claude: () => notBuilt("Claude Code"),
  codex: () => notBuilt("Codex"),
};

function notBuilt(displayName: string): never {
  throw new Error(`The ${displayName} adapter is not built yet.`);
}

export function createAdapterRegistry(overrides: Partial<Record<ProviderId, ProviderAdapter>> = {}): AdapterRegistry {
  return {
    providers: () => [...PROVIDERS],
    get: (provider) => overrides[provider] ?? DEFAULT_ADAPTERS[provider](),
  };
}
