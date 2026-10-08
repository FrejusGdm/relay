// relay statusline claude (add-provider-adapters, design decision 13; the provider-hook-setup spec,
// "relay statusline claude"). Claude Code runs it on every status-line refresh. It records the
// usage windows for the account, then runs the person's own status line with the same input and
// passes its output and exit code through. It prints nothing of its own.
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { join, resolve } from "node:path";
import { readAvailability, recordReading } from "../accounts/availability";
import { usesProviderDefaultFolder } from "../accounts/profile";
import type { LimitWindow } from "../adapters/types";
import { resetTimeFromValue } from "../adapters/reset-time";
import type { Account, RelayConfig } from "../core/config/types";
import type { Io } from "../cli/io";
import { now } from "../platform/clock";
import { savedStatusLine, savedStatusLineWithoutConfig } from "./install";

const MAX_INPUT = 1024 * 1024;
const INPUT_TIME_MS = 200;
const ORIGINAL_TIME_LIMIT_MS = 2000;
const MAX_OUTPUT = 1024 * 1024;
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

// config is null when config.toml is invalid. Without an account, nothing is recorded, but the
// person's own status line still runs.
export async function runStatusLine(options: {
  io: Io;
  env: Record<string, string | undefined>;
  config: RelayConfig | null;
  relayHome: string;
  homedir: string;
}): Promise<number> {
  const { io, env } = options;
  const input = io.stdinIsTTY ? Buffer.alloc(0) : await io.readStdin(MAX_INPUT, INPUT_TIME_MS);
  const account = options.config === null ? undefined : statusLineAccount(options.config, env, options.homedir);
  const original = account === undefined
    ? savedStatusLineWithoutConfig(options.relayHome, env.RELAY_TARGET, resolve(env.CLAUDE_CONFIG_DIR || join(options.homedir, ".claude")))
    : savedStatusLine(options.relayHome, account).value;
  if (account !== undefined) record(options.relayHome, account, input);
  if (!isObject(original) || original.type !== "command" || typeof original.command !== "string") return 0;
  return runOriginal(original.command, input, env, io);
}

function record(relayHome: string, account: Account, input: Buffer): void {
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.toString("utf8"));
    } catch {
      parsed = undefined;
    }
    const windows = statusLineWindows(parsed);
    const recorded = readAvailability(relayHome, account).windows.filter((window) => window.source === "status_line");
    if (windows.length > 0 && !sameWindows(windows, recorded)) {
      const full = windows.filter((window) => window.usedPercent! >= 100 && window.resetsAt !== undefined);
      const retryAt = full.length === 0 ? undefined : new Date(Math.max(...full.map((window) => window.resetsAt!.getTime())));
      recordReading(relayHome, account, {
        state: windows.some((window) => window.usedPercent! >= 100) ? "quota_exhausted" : "available",
        windows, observedAt: now(), source: "status_line", ...(retryAt === undefined ? {} : { retryAt }),
      });
    }
  } catch {
    // A reading that cannot be recorded must not hide the person's status line.
  }
}

// Runs the person's command in its own process group. At the time limit, relay kills the group,
// so also the programs the command started, stops reading and shows what it printed until then.
// It shows at most 1 MiB.
function runOriginal(command: string, input: Buffer, env: Record<string, string | undefined>, io: Io): Promise<number> {
  return new Promise((done) => {
    const child = spawn("sh", ["-c", command], { env, stdio: ["pipe", "pipe", "inherit"], detached: true });
    const chunks: Buffer[] = [];
    let size = 0;
    let exitCode: number | null = null;
    let outputEnded = false;
    let finished = false;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdout!.destroy();
      io.out(Buffer.concat(chunks).toString("utf8"));
      done(code);
    };
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // The group has already ended.
      }
      finish(exitCode ?? 0);
    }, ORIGINAL_TIME_LIMIT_MS);
    child.stdin!.on("error", () => {});
    child.stdin!.end(input);
    child.stdout!.on("data", (chunk: Buffer) => {
      if (size < MAX_OUTPUT) chunks.push(chunk.subarray(0, MAX_OUTPUT - size));
      size += chunk.length;
    });
    child.stdout!.on("end", () => {
      outputEnded = true;
      if (exitCode !== null) finish(exitCode);
    });
    child.on("exit", (code, signal) => {
      exitCode = code ?? (signal === null ? 0 : 128 + (osConstants.signals[signal] ?? 0));
      if (outputEnded) finish(exitCode);
    });
    child.on("error", () => finish(127));
  });
}
