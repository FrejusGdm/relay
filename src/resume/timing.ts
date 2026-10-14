// When relay resumes after a usage limit (add-resume-at-reset, design decisions 2 to 4): where the
// reset time comes from, the margin after it, the checks every 15 minutes when it is unknown, and
// when relay stops trying. Every comparison reads the time through now().
import { readAvailability } from "../accounts/availability";
import { buildAgentEnv } from "../accounts/environment";
import type { Availability, FailureReason, ProviderAdapter, ReadingSource } from "../adapters/types";
import type { Account } from "../core/config/types";
import { now } from "../platform/clock";

export const CONTINUE_PROMPT = "The usage limit has reset. Continue the task from where you stopped.";
export const DEFAULT_MAX_RESUMES = 3;
export const MAX_RESUMES_LIMIT = 20;

export interface Timing {
  // How often the daemon looks at the waits.
  tickMs: number;
  // The check interval when the reset time is unknown, and its random delay.
  checkMs: number;
  checkJitterMs: number;
  // How long after a reset time relay resumes, and its random delay.
  marginMs: number;
  resetJitterMs: number;
  // How long a wait without a known reset time lasts at most: 7 days, the longest usage window.
  maxUnknownMs: number;
}

const PRODUCTION: Timing = {
  tickMs: 5_000, checkMs: 15 * 60_000, checkJitterMs: 60_000, marginMs: 60_000, resetJitterMs: 30_000, maxUnknownMs: 7 * 86_400_000,
};

// The test preload (RELAY_TEST=1) may shorten the times; nothing else can, so a person's
// environment never makes relay check more often than every 15 minutes.
export function resumeTiming(env: Record<string, string | undefined>): Timing {
  if (process.env.RELAY_TEST !== "1") return PRODUCTION;
  const read = (name: string): number | undefined => {
    const value = Number(env[name]);
    return env[name] !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined;
  };
  const margin = read("RELAY_TEST_RESUME_MARGIN_MS");
  return {
    tickMs: read("RELAY_TEST_RESUME_TICK_MS") ?? PRODUCTION.tickMs,
    checkMs: read("RELAY_TEST_RESUME_CHECK_MS") ?? PRODUCTION.checkMs,
    checkJitterMs: margin === undefined ? PRODUCTION.checkJitterMs : 0,
    marginMs: margin ?? PRODUCTION.marginMs,
    resetJitterMs: margin === undefined ? PRODUCTION.resetJitterMs : 0,
    maxUnknownMs: read("RELAY_TEST_RESUME_MAX_UNKNOWN_MS") ?? PRODUCTION.maxUnknownMs,
  };
}

export function isUsageLimit(reason: FailureReason | null | undefined): reason is "usage_limit" | "rate_limit" {
  return reason === "usage_limit" || reason === "rate_limit";
}

// When to resume after a known reset time: providers round reset times to the minute, and the
// minute they report can move by one, so relay waits a minute more and a random part of 30 seconds.
export function afterReset(resetAt: Date, timing: Timing, random = Math.random): Date {
  return new Date(resetAt.getTime() + timing.marginMs + Math.floor(random() * timing.resetJitterMs));
}

// The next check when the reset time is unknown: 15 minutes and a random part of a minute, never
// sooner.
export function nextUnknownCheck(from: Date, timing: Timing, random = Math.random): Date {
  return new Date(from.getTime() + timing.checkMs + Math.floor(random() * timing.checkJitterMs));
}

export interface ResetTime {
  at: Date;
  source: ReadingSource;
}

// The reset time of a stop: the stop's own reading, then the account's recorded availability, then
// for Codex a live reading, the first one that names a time after the stop.
export async function findResetTime(options: {
  stopReset: ResetTime | null; stoppedAt: Date; account: Account; adapter: ProviderAdapter; relayHome: string;
  env: Record<string, string | undefined>;
}): Promise<ResetTime | null> {
  const { stopReset, stoppedAt, account, relayHome } = options;
  if (stopReset !== null && stopReset.at > stoppedAt) return stopReset;
  const recorded = readAvailability(relayHome, account);
  if (isLimited(recorded) && recorded.retryAt !== undefined && recorded.retryAt > stoppedAt) return { at: recorded.retryAt, source: recorded.source };
  const live = await liveReading(options.adapter, account, options.env);
  if (live !== null && isLimited(live) && live.retryAt !== undefined && live.retryAt > stoppedAt) return { at: live.retryAt, source: live.source };
  return null;
}

export type CheckResult = { kind: "reset_known"; reset: ResetTime } | { kind: "still_limited" } | { kind: "resuming" };

// A check of an account whose reset time is unknown (design decision 3). A future reset time makes
// relay wait for it. A reading taken after the stop that still says the account is limited means
// another 15 minutes. Anything else, also no newer reading at all, makes relay resume: a resume at a
// limit still in force costs no usage, and its stop often brings the missing reset time.
export async function checkAccount(options: {
  account: Account; adapter: ProviderAdapter; relayHome: string; env: Record<string, string | undefined>; stoppedAt: Date;
}): Promise<CheckResult> {
  const { account, relayHome, stoppedAt } = options;
  const today = now();
  const readings = [await liveReading(options.adapter, account, options.env), readAvailability(relayHome, account, today)]
    .filter((reading): reading is Availability => reading !== null);
  for (const reading of readings) {
    if (isLimited(reading) && reading.retryAt !== undefined && reading.retryAt > today) {
      return { kind: "reset_known", reset: { at: reading.retryAt, source: reading.source } };
    }
  }
  if (readings.some((reading) => isLimited(reading) && reading.retryAt === undefined && reading.observedAt > stoppedAt)) {
    return { kind: "still_limited" };
  }
  return { kind: "resuming" };
}

function isLimited(reading: Availability): boolean {
  return reading.state === "quota_exhausted" || reading.state === "rate_limited";
}

// Only Codex can be asked for its limits without spending usage (account/rateLimits/read). Claude
// Code's readings come only from what relay already recorded (docs/adapters.md, "Availability").
async function liveReading(adapter: ProviderAdapter, account: Account, env: Record<string, string | undefined>): Promise<Availability | null> {
  if (account.provider !== "codex") return null;
  try {
    const reading = await adapter.availability(account, buildAgentEnv(account, env));
    return reading.source === "none" ? null : reading;
  } catch {
    return null;
  }
}
