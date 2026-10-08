// Turns the argument of relay switch into one of the person's accounts (add-relay-switch, design
// decision 4), and names accounts the way the handoff output shows them.
import { CommandError } from "../cli/errors";
import { ExitCode } from "../cli/exit-codes";
import type { Provider } from "../adapters/providers";
import type { Account, RelayConfig } from "../core/config/types";
import { quote } from "../core/quote";
import { policyOf } from "../policies/load";

const ARGUMENT = /^(claude|codex)(?::([a-z0-9][a-z0-9-]{0,31}))?$/;
const COUNT_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

export function displayName(provider: Provider): string {
  return policyOf(provider).displayName;
}

// "Claude Code · personal"
export function accountLabel(account: Pick<Account, "provider" | "name">): string {
  return `${displayName(account.provider)} · ${account.name}`;
}

export function resolveAccount(arg: string, config: RelayConfig): Account {
  const match = ARGUMENT.exec(arg);
  if (match === null) {
    throw usage(`${quote(arg)} is not an account. Accounts look like provider:name, for example codex:personal.`);
  }
  const provider = match[1] as Provider;
  const name = match[2];
  if (name !== undefined) {
    const account = config.accounts.find((candidate) => candidate.id === arg);
    if (account === undefined) throw usage(`${arg} is not one of your accounts. Add it with relay account add ${provider} ${name}.`);
    return account;
  }
  const accounts = config.accounts.filter((account) => account.provider === provider);
  if (accounts.length === 1) return accounts[0]!;
  const fallback = accounts.find((account) => account.id === config.defaults.account);
  if (fallback !== undefined) return fallback;
  const display = displayName(provider);
  if (accounts.length === 0) throw usage(`You have no ${display} account. Add one with relay account add ${provider} <name>.`);
  const count = COUNT_WORDS[accounts.length] ?? String(accounts.length);
  const ids = accounts.map((account) => account.id);
  throw usage(`You have ${count} ${display} accounts: ${ids.join(", ")}. Name one, for example relay switch ${ids[0]}.`);
}

function usage(line: string): CommandError {
  return new CommandError(ExitCode.Usage, [line]);
}
