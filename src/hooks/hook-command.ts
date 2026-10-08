// relay hook <provider> <event> (add-provider-adapters, design decision 14): Claude Code and Codex
// run it from their hooks. It reads at most 1 MiB of input for at most 200 ms, keeps only the
// allowed fields, appends one line to the spool, prints nothing and always exits 0. Its own
// failures go to logs/hook.log, without the input.
import type { Logger } from "../core/log";
import type { Io } from "../cli/io";
import { now } from "../platform/clock";
import { EVENT_NAME, isProvider, LOGGED_EVENTS, spoolLine } from "./fields";
import { appendSpoolLine } from "./spool";

const MAX_INPUT = 1024 * 1024;
const INPUT_TIME_MS = 200;

export async function runHook(options: {
  provider: string;
  event: string;
  io: Io;
  log: Logger;
  env: Record<string, string | undefined>;
  relayHome: string;
}): Promise<void> {
  const { provider, event, io, log } = options;
  const input = io.stdinIsTTY ? Buffer.alloc(0) : await io.readStdin(MAX_INPUT, INPUT_TIME_MS);
  const known = isProvider(provider) ? provider : null;
  // The two arguments are logged only when they are a supported provider and one of its known
  // events, so a value an agent passes by mistake never reaches the log.
  const fields = { provider: known, event: known !== null && LOGGED_EVENTS[known].includes(event) ? event : null };
  const outcome = (text: string) => log.info("hook received", { ...fields, outcome: text });
  if (known === null) return outcome("the provider is not supported");
  if (!EVENT_NAME.test(event)) return outcome("the event name is not valid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.toString("utf8"));
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return outcome("the input is not a JSON object");
  try {
    const written = appendSpoolLine(options.relayHome, spoolLine(known, event, parsed as Record<string, unknown>, options.env, now()));
    outcome(written ? "recorded" : "not recorded: the spool is larger than 10 MB");
  } catch {
    outcome("not recorded: the spool could not be written");
  }
}
