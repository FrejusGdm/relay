// Folds hook events from the spool into the accounts' availability (add-provider-adapters, design
// decision 9). In this version relay account status does it; a later daemon takes it over. Only
// the events below change availability, always with source "hook".
import { readAvailability, markSpoolSeen, recordReading, spoolSeenUntil, type Reading } from "../accounts/availability";
import { usesProviderDefaultFolder } from "../accounts/profile";
import type { Account, RelayConfig } from "../core/config/types";
import { now } from "../platform/clock";
import type { SpoolLine } from "./fields";
import { readSpool, trimSpool } from "./spool";

const UNAVAILABLE: Record<string, string> = {
  authentication_failed: "Claude Code is signed out of this account",
  oauth_org_not_allowed: "Claude Code is signed out of this account",
  billing_error: "Claude Code reported a billing problem on this account",
  account_on_hold: "Claude Code says this account is on hold",
};

// The account a spool line belongs to: RELAY_TARGET, else the account whose profile folder the
// line names, else, for "default", the account that uses the provider's own folder.
export function spoolLineAccount(line: SpoolLine, config: RelayConfig, home: string): Account | undefined {
  const accounts = config.accounts.filter((account) => account.provider === line.provider);
  if (line.relay_target !== null) return accounts.find((account) => account.id === line.relay_target);
  if (line.profile === "default") return accounts.find((account) => usesProviderDefaultFolder(account, home));
  return accounts.find((account) => account.profileDir === line.profile);
}

// The reading a hook event gives, or null when the event does not change availability.
export function readingFromHook(line: SpoolLine, relayHome: string, account: Account): Reading | null {
  const observedAt = new Date(line.received_at);
  const base = { windows: [], observedAt, source: "hook" as const };
  const error = line.fields.error;
  if (line.event === "Stop") return { ...base, state: "available", detail: "The last turn finished normally" };
  if (line.provider !== "claude") return null;
  if (line.event === "Notification" && line.fields.notification_type === "quota_auto_resume_fired") {
    return { ...base, state: "available", detail: "Claude Code continued after its reset." };
  }
  if (line.event !== "StopFailure" || typeof error !== "string") return null;
  if (error === "rate_limit") {
    // The reset time comes from the latest status-line reading, when a window there is full.
    const full = readAvailability(relayHome, account).windows.filter((window) =>
      window.source === "status_line" && (window.usedPercent ?? 0) >= 100 && window.resetsAt !== undefined && window.resetsAt > observedAt);
    const retryAt = full.length === 0 ? undefined : new Date(Math.max(...full.map((window) => window.resetsAt!.getTime())));
    return { ...base, state: "rate_limited", detail: "Claude Code reported a rate limit", ...(retryAt === undefined ? {} : { retryAt }) };
  }
  const detail = UNAVAILABLE[error];
  return detail === undefined ? null : { ...base, state: "unavailable", detail };
}

// Folds the spool lines of one account that are newer than the ones folded before.
export function foldSpool(relayHome: string, config: RelayConfig, account: Account, home: string): void {
  trimSpool(relayHome);
  const seen = spoolSeenUntil(relayHome, account)?.getTime() ?? 0;
  let newest = seen;
  for (const line of readSpool(relayHome)) {
    const time = Date.parse(line.received_at);
    if (!(time > seen) || time > now().getTime() + 60_000) continue;
    if (spoolLineAccount(line, config, home)?.id !== account.id) continue;
    const reading = readingFromHook(line, relayHome, account);
    if (reading !== null) recordReading(relayHome, account, reading);
    newest = Math.max(newest, time);
  }
  if (newest > seen) markSpoolSeen(relayHome, account, new Date(newest));
}
