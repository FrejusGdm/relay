// The accounts of the validated settings (add-provider-adapters, design decision 10).
import { join } from "node:path";
import { PROVIDERS, type Provider } from "../adapters/providers";
import type { Account, AccountId, RelayConfig } from "../core/config/types";

export const ACCOUNT_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

// "claude:work", or the two words "claude" "work". Returns null for any other shape; the provider
// and the name are checked separately.
export function splitAccountArgs(args: string[]): { provider: string; name: string } | null {
  if (args.length === 2) return { provider: args[0]!, name: args[1]! };
  if (args.length !== 1) return null;
  const colon = args[0]!.indexOf(":");
  if (colon === -1) return null;
  return { provider: args[0]!.slice(0, colon), name: args[0]!.slice(colon + 1) };
}

export function findAccount(config: RelayConfig, id: string): Account | undefined {
  return config.accounts.find((account) => account.id === id);
}

export function defaultProfileDir(relayHome: string, provider: Provider, name: string): string {
  return join(relayHome, "profiles", `${provider}-${name}`);
}

// Where the settings still name the account, besides its own table.
export function accountReferences(config: RelayConfig, id: AccountId): { projects: string[]; other: boolean } {
  return {
    projects: config.projects.filter((project) => project.allow.includes(id)).map((project) => project.path),
    other: config.defaults.account === id
      || config.t3.instances.some((instance) => instance.account === id)
      || config.limits.some((limit) => limit.account === id || limit.switchTo === id),
  };
}
