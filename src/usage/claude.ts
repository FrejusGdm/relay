// Claude Code's usage reading (the usage-readings spec of add-t3-limit-rules, "Claude readings"; used
// by add-resume-at-reset): `claude -p "/usage" --no-session-persistence` with the account's
// environment, standard input at end of file, the working folder RELAY_HOME/run/usage and a
// 30-second limit. The command is local and spends no usage (docs/research/t3-outside-access.md,
// "Checked later"). Its lines look like
//   Current session: 34% used · resets Oct 8, 1:49pm (UTC)
//   Current week (all models): 91% used · resets Oct 12, 7:59am (UTC)
// and the reading is recorded as the account's availability. Per-model weekly lines are ignored.
import { join } from "node:path";
import { recordReading } from "../accounts/availability";
import { buildAgentEnv } from "../accounts/environment";
import { findProgram } from "../adapters/program";
import { runShortCommand } from "../adapters/process";
import { resetTimeInZone } from "../adapters/reset-time";
import type { Availability, LimitWindow } from "../adapters/types";
import type { Account } from "../core/config/types";
import { makePrivateFolder } from "../handoff/files";
import { now } from "../platform/clock";

const TIME_LIMIT_MS = 30_000;
const LINES: { name: "five_hour" | "seven_day"; minutes: number; pattern: RegExp }[] = [
  { name: "five_hour", minutes: 300, pattern: /^Current session:\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets\s+(.+))?$/m },
  { name: "seven_day", minutes: 10_080, pattern: /^Current week \(all models\):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets\s+(.+))?$/m },
];

// Reads the output of /usage. Null when it holds no line relay recognizes.
export function parseClaudeUsage(text: string, observedAt: Date = now()): Omit<Availability, "account"> | null {
  const windows: LimitWindow[] = [];
  for (const line of LINES) {
    const match = line.pattern.exec(text);
    if (match === null) continue;
    const resetsAt = match[2] === undefined ? undefined : resetTimeInZone(match[2].trim(), observedAt);
    windows.push({
      name: line.name, windowMinutes: line.minutes, usedPercent: Number(match[1]), source: "usage_command",
      ...(resetsAt === undefined ? {} : { resetsAt }),
    });
  }
  if (windows.length === 0) return null;
  const full = windows.filter((window) => (window.usedPercent ?? 0) >= 100);
  const resets = full.flatMap((window) => (window.resetsAt === undefined ? [] : [window.resetsAt.getTime()]));
  return {
    state: full.length > 0 ? "quota_exhausted" : "available", windows, observedAt, source: "usage_command",
    ...(full.length > 0 && resets.length === full.length ? { retryAt: new Date(Math.max(...resets)) } : {}),
  };
}

// Runs /usage for the account and records the reading. Null when the program is missing, fails,
// or prints nothing relay recognizes.
export async function readClaudeUsage(
  account: Account, env: Record<string, string | undefined>, relayHome: string,
): Promise<Availability | null> {
  if (account.provider !== "claude") return null;
  const path = findProgram("claude", env);
  if (path === null) return null;
  const cwd = join(relayHome, "run", "usage");
  try {
    makePrivateFolder(cwd);
    const result = await runShortCommand({
      path, args: ["-p", "/usage", "--no-session-persistence"], env: buildAgentEnv(account, env), timeoutMs: TIME_LIMIT_MS, cwd,
    });
    if (result.code !== 0) return null;
    const reading = parseClaudeUsage(result.stdout);
    if (reading === null) return null;
    recordReading(relayHome, account, reading);
    return { account: account.id, ...reading };
  } catch {
    return null;
  }
}
