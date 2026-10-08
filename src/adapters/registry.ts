// Finds the adapter of a provider (add-provider-adapters, design decision 1). Tests pass overrides,
// such as the in-process fake adapter; the production registry has no fake.
import { createClaudeAdapter } from "./claude/adapter";
import { createCodexAdapter } from "./codex/adapter";
import { PROVIDERS } from "./providers";
import type { ProviderAdapter, ProviderId } from "./types";

export interface AdapterRegistry {
  providers(): ProviderId[];
  get(provider: ProviderId): ProviderAdapter;
}

const DEFAULT_ADAPTERS: Record<ProviderId, (env: Record<string, string | undefined>) => ProviderAdapter> = {
  claude: createClaudeAdapter,
  codex: createCodexAdapter,
};

// `env` is the environment the adapters find their programs in: RELAY_CLAUDE_BIN, RELAY_CODEX_BIN,
// PATH and HOME.
export function createAdapterRegistry(
  overrides: Partial<Record<ProviderId, ProviderAdapter>> = {},
  env: Record<string, string | undefined> = process.env,
): AdapterRegistry {
  return {
    providers: () => [...PROVIDERS],
    get: (provider) => overrides[provider] ?? DEFAULT_ADAPTERS[provider](env),
  };
}
