// relay hook <provider> <event> (add-provider-adapters, design decision 14; add-daemon-api-and-status,
// design decision 18): Claude Code and Codex run it from their hooks. It reads at most 1 MiB of
// input for at most 200 ms and keeps only the allowed fields. It gives the daemon 150 ms to accept
// the event and appends it to the spool otherwise. It prints nothing and always exits 0;
// src/cli/main.ts ends the process 500 ms after it started, whatever happens. Its own failures go
// to logs/hook.log, without the input.
import type { Logger } from "../core/log";
import type { Io } from "../cli/io";
import { postHook } from "../client/api-client";
import { runtimeDir } from "../daemon/paths";
import { now } from "../platform/clock";
import { EVENT_NAME, isProvider, LOGGED_EVENTS, spoolLine } from "./fields";
import { appendSpoolLine } from "./spool";

const MAX_INPUT = 1024 * 1024;
const INPUT_TIME_MS = 200;
const DAEMON_TIME_MS = 150;

export async function runHook(options: {
  provider: string;
  event: string;
  io: Io;
  log: Logger;
  env: Record<string, string | undefined>;
  relayHome: string;
}): Promise<void> {
  const { provider, event, io, log } = options;
  const known = isProvider(provider) ? provider : null;
  // The two arguments are logged only when they are a supported provider and one of its known
  // events, so a value an agent passes by mistake never reaches the log.
  const fields = { provider: known, event: known !== null && LOGGED_EVENTS[known].includes(event) ? event : null };
  const outcome = (text: string) => log.info("hook received", { ...fields, outcome: text });
  if (known === null) return outcome("the provider is not supported");
  if (!EVENT_NAME.test(event)) return outcome("the event name is not valid");
  const input = io.stdinIsTTY ? Buffer.alloc(0) : await io.readStdin(MAX_INPUT, INPUT_TIME_MS);
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.toString("utf8"));
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return outcome("the input is not a JSON object");
  const line = spoolLine(known, event, parsed as Record<string, unknown>, options.env, now());
  if (await sentToDaemon(options.env, options.relayHome, known, event, JSON.stringify(line))) return outcome("sent to the daemon");
  try {
    const written = appendSpoolLine(options.relayHome, line);
    outcome(written ? "recorded" : "not recorded: the spool is larger than 10 MB");
  } catch {
    outcome("not recorded: the spool could not be written");
  }
}

// False when no daemon accepted the event in time, also when the runtime directory or the socket
// is not private; the event then goes to the spool.
async function sentToDaemon(
  env: Record<string, string | undefined>,
  relayHome: string,
  provider: string,
  event: string,
  body: string,
): Promise<boolean> {
  try {
    return await postHook(runtimeDir(env, relayHome), provider, event, body, { timeoutMs: DAEMON_TIME_MS });
  } catch {
    return false;
  }
}
