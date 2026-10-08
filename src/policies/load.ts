// The policy of each provider, read from the adapters' policy.toml files at build time. An invalid
// file makes this module throw when it loads, so the tests, and with them the build, fail.
import claudePolicy from "../adapters/claude/policy.toml";
import codexPolicy from "../adapters/codex/policy.toml";
import type { ProviderId, ProviderPolicy } from "../adapters/types";
import { now } from "../platform/clock";
import { parsePolicy } from "./schema";

export const POLICY_FILES: Record<ProviderId, string> = {
  claude: "src/adapters/claude/policy.toml",
  codex: "src/adapters/codex/policy.toml",
};

const POLICIES: Record<ProviderId, ProviderPolicy> = {
  claude: parsePolicy(claudePolicy, POLICY_FILES.claude),
  codex: parsePolicy(codexPolicy, POLICY_FILES.codex),
};

export function policyOf(provider: ProviderId): ProviderPolicy {
  return POLICIES[provider];
}

// Whole days from checked_on to today's date where the person is.
export function policyAgeDays(policy: ProviderPolicy, today: Date = now()): number {
  const [year, month, day] = policy.checkedOn.split("-").map(Number) as [number, number, number];
  const checked = Date.UTC(year, month - 1, day);
  const local = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((local - checked) / 86_400_000);
}

export function isStale(policy: ProviderPolicy, today: Date = now()): boolean {
  return policyAgeDays(policy, today) > policy.maxAgeDays;
}
