// The recorded availability of one account, RELAY_HOME/accounts/<provider>-<name>/availability.json
// (add-provider-adapters, design decision 9). Every reading says where it came from, and relay
// never infers that a limit has ended: once the reset time passes, the state reads as unknown.
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Availability, AvailabilityState, LimitWindow, ReadingSource } from "../adapters/types";
import type { Account } from "../core/config/types";
import { now } from "../platform/clock";
import { accountFolder, readJsonFile, writeJsonFile } from "./files";

const STATES: AvailabilityState[] = ["available", "rate_limited", "quota_exhausted", "unavailable", "unknown"];
const SOURCES: ReadingSource[] = ["provider_api", "stream_event", "hook", "status_line", "message_text", "user", "none"];
export const RESET_PASSED = "The reset time has passed; relay has not measured since.";

type AccountRef = Pick<Account, "id" | "provider" | "name">;
export type Reading = Omit<Availability, "account">;

interface WindowFile { name: string; window_minutes: number | null; used_percent: number | null; resets_at: string | null; source: ReadingSource }
interface AvailabilityFile {
  v: 1;
  account: string;
  state: AvailabilityState;
  retry_at: string | null;
  windows: WindowFile[];
  observed_at: string;
  source: ReadingSource;
  detail: string | null;
  spool_seen_until: string | null;
}

export function availabilityPath(relayHome: string, account: AccountRef): string {
  return join(accountFolder(relayHome, account), "availability.json");
}

// Removes the recorded readings, for an account that is added again under the name of an earlier
// one.
export function forgetAvailability(relayHome: string, account: AccountRef): void {
  rmSync(availabilityPath(relayHome, account), { force: true });
}

// The account's availability as relay reports it now: the recorded reading, or `unknown` with
// source `none` when there is none, and `unknown` when a limit's reset time has passed.
export function readAvailability(relayHome: string, account: AccountRef, today: Date = now()): Availability {
  const file = readFile(relayHome, account);
  if (file === null) return { account: account.id, state: "unknown", windows: [], observedAt: today, source: "none" };
  const reading: Availability = {
    account: account.id,
    state: file.state,
    windows: file.windows.map(fromWindowFile),
    observedAt: new Date(file.observed_at),
    source: file.source,
    ...(file.retry_at === null ? {} : { retryAt: new Date(file.retry_at) }),
    ...(file.detail === null ? {} : { detail: file.detail }),
  };
  const limited = reading.state === "quota_exhausted" || reading.state === "rate_limited";
  if (limited && reading.retryAt !== undefined && reading.retryAt.getTime() <= today.getTime()) {
    return { ...reading, state: "unknown", detail: RESET_PASSED };
  }
  return reading;
}

// Folds a reading into the file: a reading at least as new as the recorded one replaces the state,
// and windows merge by name, a newer window replacing an older one.
export function recordReading(relayHome: string, account: AccountRef, reading: Reading): void {
  const old = readFile(relayHome, account);
  const newer = old === null || reading.observedAt.getTime() >= Date.parse(old.observed_at);
  const windows = new Map<string, WindowFile>(old?.windows.map((window) => [window.name, window] as const));
  for (const window of reading.windows) {
    const previous = windows.get(window.name);
    if (previous === undefined || newer) windows.set(window.name, toWindowFile(window));
  }
  const base: AvailabilityFile = newer || old === null
    ? {
        v: 1, account: account.id, state: reading.state, retry_at: reading.retryAt?.toISOString() ?? null,
        windows: [], observed_at: reading.observedAt.toISOString(), source: reading.source,
        detail: reading.detail ?? null, spool_seen_until: old?.spool_seen_until ?? null,
      }
    : old;
  writeJsonFile(availabilityPath(relayHome, account), { ...base, windows: [...windows.values()] });
}

function readFile(relayHome: string, account: AccountRef): AvailabilityFile | null {
  const raw = readJsonFile(availabilityPath(relayHome, account));
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (value.v !== 1 || !STATES.includes(value.state as AvailabilityState) || !SOURCES.includes(value.source as ReadingSource)) return null;
  if (typeof value.observed_at !== "string" || Number.isNaN(Date.parse(value.observed_at))) return null;
  const time = (key: string) => (typeof value[key] === "string" && !Number.isNaN(Date.parse(value[key] as string)) ? (value[key] as string) : null);
  const windows = Array.isArray(value.windows) ? value.windows.filter(isWindowFile) : [];
  return {
    v: 1, account: account.id, state: value.state as AvailabilityState, retry_at: time("retry_at"), windows,
    observed_at: value.observed_at, source: value.source as ReadingSource,
    detail: typeof value.detail === "string" ? value.detail : null, spool_seen_until: time("spool_seen_until"),
  };
}

function isWindowFile(value: unknown): value is WindowFile {
  if (typeof value !== "object" || value === null) return false;
  const window = value as Record<string, unknown>;
  const numberOrNull = (key: string) => window[key] === null || window[key] === undefined || typeof window[key] === "number";
  return typeof window.name === "string" && SOURCES.includes(window.source as ReadingSource)
    && numberOrNull("window_minutes") && numberOrNull("used_percent")
    && (window.resets_at === null || window.resets_at === undefined || (typeof window.resets_at === "string" && !Number.isNaN(Date.parse(window.resets_at))));
}

function toWindowFile(window: LimitWindow): WindowFile {
  return {
    name: window.name, window_minutes: window.windowMinutes ?? null, used_percent: window.usedPercent ?? null,
    resets_at: window.resetsAt?.toISOString() ?? null, source: window.source,
  };
}

function fromWindowFile(window: WindowFile): LimitWindow {
  return {
    name: window.name, source: window.source,
    ...(window.window_minutes == null ? {} : { windowMinutes: window.window_minutes }),
    ...(window.used_percent == null ? {} : { usedPercent: window.used_percent }),
    ...(window.resets_at == null ? {} : { resetsAt: new Date(window.resets_at) }),
  };
}
