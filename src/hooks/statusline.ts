// relay statusline claude (add-provider-adapters, design decision 13; the provider-hook-setup spec,
// "relay statusline claude"). Claude Code runs it on every status-line refresh. It records the
// usage windows for the account, then runs the person's own status line with the same input and
// passes its output and exit code through. It prints nothing of its own.
import { resolve } from "node:path";
import { readAvailability, recordReading } from "../accounts/availability";
import { usesProviderDefaultFolder } from "../accounts/profile";
import type { LimitWindow } from "../adapters/types";
import { resetTimeFromValue } from "../adapters/reset-time";
import type { Account, RelayConfig } from "../core/config/types";
import type { Io } from "../cli/io";
import { now } from "../platform/clock";
import { savedStatusLine } from "./install";

const MAX_INPUT = 1024 * 1024;
const INPUT_TIME_MS = 200;
const ORIGINAL_TIME_LIMIT_MS = 2000;
const WINDOW_MINUTES = { five_hour: 300, seven_day: 10080 } as const;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

// The account the status line belongs to: RELAY_TARGET, else the account whose profile folder is
// CLAUDE_CONFIG_DIR, else the account that uses ~/.claude.
export function statusLineAccount(config: RelayConfig, env: Record<string, string | undefined>, home: string): Account | undefined {
  const claude = config.accounts.filter((account) => account.provider === "claude");
  const target = claude.find((account) => account.id === env.RELAY_TARGET);
  if (target !== undefined) return target;
  const dir = env.CLAUDE_CONFIG_DIR;
  if (dir) return claude.find((account) => account.profileDir === resolve(dir));
  return claude.find((account) => usesProviderDefaultFolder(account, home));
}

// The five-hour and seven-day windows of the status-line input.
export function statusLineWindows(input: unknown): LimitWindow[] {
  if (!isObject(input) || !isObject(input.rate_limits)) return [];
  const windows: LimitWindow[] = [];
  for (const name of ["five_hour", "seven_day"] as const) {
    const window = input.rate_limits[name];
    if (!isObject(window) || typeof window.used_percentage !== "number") continue;
    const resetsAt = resetTimeFromValue(window.resets_at);
    windows.push({
      name, windowMinutes: WINDOW_MINUTES[name], usedPercent: window.used_percentage, source: "status_line",
      ...(resetsAt === undefined ? {} : { resetsAt }),
    });
  }
  return windows;
}

function sameWindows(a: LimitWindow[], b: LimitWindow[]): boolean {
  const key = (windows: LimitWindow[]) => JSON.stringify(windows.map((w) => [w.name, w.usedPercent, w.resetsAt?.getTime() ?? null]).sort());
  return key(a) === key(b);
}

export async function runStatusLine(options: {
  io: Io;
  env: Record<string, string | undefined>;
  config: RelayConfig;
  relayHome: string;
  homedir: string;
}): Promise<number> {
  const { io, env } = options;
  const input = io.stdinIsTTY ? Buffer.alloc(0) : await io.readStdin(MAX_INPUT, INPUT_TIME_MS);
  const account = statusLineAccount(options.config, env, options.homedir);
  if (account === undefined) return 0;
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.toString("utf8"));
    } catch {
      parsed = undefined;
    }
    const windows = statusLineWindows(parsed);
    const recorded = readAvailability(options.relayHome, account).windows.filter((window) => window.source === "status_line");
    if (windows.length > 0 && !sameWindows(windows, recorded)) {
      const full = windows.filter((window) => window.usedPercent! >= 100 && window.resetsAt !== undefined);
      const retryAt = full.length === 0 ? undefined : new Date(Math.max(...full.map((window) => window.resetsAt!.getTime())));
      recordReading(options.relayHome, account, {
        state: windows.some((window) => window.usedPercent! >= 100) ? "quota_exhausted" : "available",
        windows, observedAt: now(), source: "status_line", ...(retryAt === undefined ? {} : { retryAt }),
      });
    }
  } catch {
    // A reading that cannot be recorded must not hide the person's status line.
  }
  const original = savedStatusLine(options.relayHome, account).value;
  if (!isObject(original) || original.type !== "command" || typeof original.command !== "string") return 0;
  return runOriginal(original.command, input, env, io);
}

async function runOriginal(command: string, input: Buffer, env: Record<string, string | undefined>, io: Io): Promise<number> {
  const child = Bun.spawn(["sh", "-c", command], { env, stdin: new Blob([input]), stdout: "pipe", stderr: "inherit" });
  const timer = setTimeout(() => child.kill("SIGKILL"), ORIGINAL_TIME_LIMIT_MS);
  const output = await new Response(child.stdout).text();
  const code = await child.exited;
  clearTimeout(timer);
  io.out(output);
  return code;
}
