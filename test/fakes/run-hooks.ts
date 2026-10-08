// Runs the command hooks and the status line that a settings file configures, the way Claude Code
// (settings.json) and Codex (hooks.json) do: each command runs with `sh -c`, receives the event's
// JSON on standard input, and is stopped when its time limit passes.
// Both files use {"hooks":{"<Event>":[{"matcher":"…","hooks":[{"type":"command","command":"…","timeout":5}]}]}}.
import { readFileSync } from "node:fs";

export interface HookRun { command: string; exitCode: number | null; timedOut: boolean }

type Json = Record<string, unknown>;

function readSettings(file: string): Json | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
  } catch {
    return null;
  }
}

// A group without a matcher, or with "" or "*", applies to every occurrence of the event. Otherwise
// the matcher is a regular expression tested against the event's own value, such as SessionStart's
// `source` or Notification's `notification_type`.
function groupApplies(matcher: unknown, matchValue: string | undefined): boolean {
  if (matcher === undefined || matcher === null || matcher === "" || matcher === "*") return true;
  if (typeof matcher !== "string" || matchValue === undefined) return false;
  try {
    return new RegExp(`^(?:${matcher})$`).test(matchValue);
  } catch {
    return false;
  }
}

async function runCommand(command: string, input: Json, cwd: string, timeoutSeconds: number, captureOutput: boolean): Promise<HookRun & { stdout: string }> {
  const child = Bun.spawn(["sh", "-c", command], {
    cwd,
    env: process.env,
    stdin: new Blob([JSON.stringify(input)]),
    stdout: captureOutput ? "pipe" : "ignore",
    stderr: "ignore",
  });
  const output = captureOutput ? new Response(child.stdout as ReadableStream).text() : Promise.resolve("");
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutSeconds * 1000);
  await child.exited;
  clearTimeout(timer);
  // A program the command started in the background can keep the output open after the shell has
  // ended, so the output is not awaited for long.
  const stdout = await Promise.race([output, new Promise<string>((done) => setTimeout(() => done(""), 100))]);
  return { command, exitCode: child.exitCode, timedOut, stdout };
}

// Runs every command hook configured for `event`, one after another, and returns what ran.
export async function runHooks(
  settingsFile: string,
  event: string,
  input: Json,
  options: { cwd: string; matchValue?: string; defaultTimeoutSeconds: number },
): Promise<HookRun[]> {
  const hooks = readSettings(settingsFile)?.hooks;
  if (typeof hooks !== "object" || hooks === null) return [];
  const groups = (hooks as Json)[event];
  if (!Array.isArray(groups)) return [];
  const runs: HookRun[] = [];
  for (const group of groups) {
    if (typeof group !== "object" || group === null || !groupApplies((group as Json).matcher, options.matchValue)) continue;
    const entries = (group as Json).hooks;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const { type, command, timeout } = (entry ?? {}) as Json;
      if (type !== "command" || typeof command !== "string") continue;
      const seconds = typeof timeout === "number" && timeout > 0 ? timeout : options.defaultTimeoutSeconds;
      const { stdout: _ignored, ...run } = await runCommand(command, input, options.cwd, seconds, false);
      runs.push(run);
    }
  }
  return runs;
}

// The command hooks configured in a settings file, by event, for Codex's hooks/list answer.
export function listCommandHooks(settingsFile: string): { event: string; matcher: string | null; command: string; timeout: number | null }[] {
  const hooks = readSettings(settingsFile)?.hooks;
  if (typeof hooks !== "object" || hooks === null) return [];
  const list: { event: string; matcher: string | null; command: string; timeout: number | null }[] = [];
  for (const [event, groups] of Object.entries(hooks as Json)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const { matcher, hooks: entries } = (group ?? {}) as Json;
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const { type, command, timeout } = (entry ?? {}) as Json;
        if (type !== "command" || typeof command !== "string") continue;
        list.push({
          event,
          matcher: typeof matcher === "string" ? matcher : null,
          command,
          timeout: typeof timeout === "number" ? timeout : null,
        });
      }
    }
  }
  return list;
}

// Runs Claude Code's `statusLine` command, when the settings file has one, and returns its output.
export async function runStatusLine(settingsFile: string, input: Json, cwd: string): Promise<{ stdout: string; exitCode: number | null } | null> {
  const statusLine = readSettings(settingsFile)?.statusLine as Json | undefined;
  if (statusLine?.type !== "command" || typeof statusLine.command !== "string") return null;
  const run = await runCommand(statusLine.command, input, cwd, 5, true);
  return { stdout: run.stdout, exitCode: run.exitCode };
}
