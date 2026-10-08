// relay policy show <provider> (the provider-policies spec, "Showing a policy").
import { PROVIDERS, type Provider } from "../../adapters/providers";
import type { ProviderPolicy } from "../../adapters/types";
import { printable, quote } from "../../core/quote";
import { policyAgeDays, policyOf } from "../../policies/load";
import { ExitCode } from "../exit-codes";
import type { CommandContext } from "./registry";

// The word for one account of each provider, as in "two Claude accounts".
export const ACCOUNT_WORD: Record<Provider, string> = { claude: "Claude", codex: "Codex" };

const UNATTENDED: Record<string, string> = {
  allowed: "allowed",
  api_key_only: "only with an API key",
  unclear: "unclear",
};

export async function policy(ctx: CommandContext): Promise<number> {
  const [action, provider] = ctx.positionals as [string, string];
  if (action !== "show") {
    ctx.io.err(`relay: ${quote(action)} is not a policy action. Use relay policy show <provider>.\n`);
    return ExitCode.Usage;
  }
  if (!(PROVIDERS as readonly string[]).includes(provider)) {
    ctx.io.err(`relay has no adapter for ${printable(provider)} yet. Supported providers: ${PROVIDERS.join(", ")}.\n`);
    return ExitCode.Usage;
  }
  ctx.io.out(policyText(policyOf(provider as Provider)).map((line) => `${line}\n`).join(""));
  return ExitCode.Ok;
}

export function policyText(policy: ProviderPolicy): string[] {
  const age = policyAgeDays(policy);
  const checked = age > policy.maxAgeDays
    ? `Last checked ${policy.checkedOn} (${age} days ago). This may be out of date.`
    : `Last checked ${policy.checkedOn}.`;
  return [
    `${policy.displayName} policy notes`,
    "",
    policy.summary,
    "",
    "How you can sign in:",
    ...policy.signInMethods.map((method) => `  - ${method}`),
    "",
    "What relay reads to know about usage limits:",
    ...policy.usageSignals.map((signal) => `  - ${signal}`),
    "",
    `Unattended use on a subscription: ${UNATTENDED[policy.unattendedSubscriptionUse] ?? policy.unattendedSubscriptionUse}.`,
    `Automatic switching between two ${ACCOUNT_WORD[policy.provider]} accounts: off.`,
    "",
    "What is unclear:",
    policy.unclear,
    "",
    "Terms:",
    ...termLines(policy),
    "",
    checked,
  ];
}

export function termLines(policy: ProviderPolicy): string[] {
  return policy.terms.map((term) => `  ${term.title}  ${term.url}`);
}
