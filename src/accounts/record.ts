// The account record RELAY_HOME/accounts/<provider>-<name>/account.json (add-provider-adapters,
// design decision 10). It holds only relay's own facts about the account: never an email address,
// a token or a provider account ID (docs/research/security.md section 2).
import { join } from "node:path";
import type { Account } from "../core/config/types";
import { now } from "../platform/clock";
import { accountFolder, readJsonFile, writeJsonFile } from "./files";

export interface AccountRecord {
  v: 1;
  account: string;
  added_at: string | null;
  policy_checked_on_seen: string | null;
  policy_seen_at: string | null;
  last_auth: { signed_in: boolean; method: string | null; checked_at: string } | null;
  hooks_installed_at: string | null;
  status_line_installed_at: string | null;
}

export function recordPath(relayHome: string, account: Pick<Account, "provider" | "name">): string {
  return join(accountFolder(relayHome, account), "account.json");
}

// The record, or an empty one when the file is missing or damaged. Fields relay does not know are
// dropped.
export function readAccountRecord(relayHome: string, account: Pick<Account, "id" | "provider" | "name">): AccountRecord {
  const raw = readJsonFile(recordPath(relayHome, account));
  const value = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : null);
  const auth = value.last_auth as Record<string, unknown> | null | undefined;
  return {
    v: 1,
    account: account.id,
    added_at: text("added_at"),
    policy_checked_on_seen: text("policy_checked_on_seen"),
    policy_seen_at: text("policy_seen_at"),
    last_auth: typeof auth === "object" && auth !== null && typeof auth.signed_in === "boolean" && typeof auth.checked_at === "string"
      ? { signed_in: auth.signed_in, method: typeof auth.method === "string" ? auth.method : null, checked_at: auth.checked_at }
      : null,
    hooks_installed_at: text("hooks_installed_at"),
    status_line_installed_at: text("status_line_installed_at"),
  };
}

export function updateAccountRecord(
  relayHome: string,
  account: Pick<Account, "id" | "provider" | "name">,
  change: Partial<Omit<AccountRecord, "v" | "account">>,
): AccountRecord {
  const record = { ...readAccountRecord(relayHome, account), ...change };
  writeJsonFile(recordPath(relayHome, account), record);
  return record;
}

export function authFact(status: { signedIn: boolean; method?: string }): AccountRecord["last_auth"] {
  return { signed_in: status.signedIn, method: status.method ?? null, checked_at: now().toISOString() };
}
