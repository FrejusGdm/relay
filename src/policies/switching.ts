// Whether relay may move a job on its own from one account to another (the provider-policies spec,
// "Same-provider automatic switching is off"). No setting changes the answer in this version.
import type { Account } from "../core/config/types";
import type { ProviderId } from "../adapters/types";

const SAME_PROVIDER_REASON: Record<ProviderId, string> = {
  claude: "Automatic switching between two Claude accounts is off. Anthropic's terms say plan limits assume ordinary, individual use.",
  codex: "Automatic switching between two Codex accounts is off. OpenAI's terms forbid getting around rate limits.",
};

export function mayAutoSwitch(
  from: Pick<Account, "provider">,
  to: Pick<Account, "provider">,
): { allowed: boolean; reason?: string } {
  if (from.provider === to.provider) return { allowed: false, reason: SAME_PROVIDER_REASON[from.provider] };
  return { allowed: true };
}
