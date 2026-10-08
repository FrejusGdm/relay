// What relay keeps from a hook's input (add-provider-adapters, design decision 14; the same list as
// the provider-hooks capability of add-daemon-api-and-status). Everything else, such as
// tool_input, error_details or last_assistant_message, is dropped before anything is written.
import { isAbsolute, resolve } from "node:path";
import { PROVIDERS, type Provider } from "../adapters/providers";
import { isJobId } from "../job/id";

export const HOOK_FIELDS = [
  "session_id", "cwd", "hook_event_name", "error", "notification_type", "reason", "source", "model", "turn_id",
] as const;
export const EVENT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
// Longer text values are cut to this many characters (add-daemon-api-and-status, design decision 18).
const MAX_TEXT = 1024;
const MAX_PROFILE = 4096;
// A spool line received more than this far in the future is refused, so it cannot hide newer
// readings.
const MAX_CLOCK_AHEAD_MS = 60_000;

// The event names relay may write to its log. Claude Code: its documented events
// (https://code.claude.com/docs/en/hooks). Codex: the events relay installs (design decision 13).
// Another valid name is still recorded in the spool, but logged as null.
export const LOGGED_EVENTS: Record<Provider, readonly string[]> = {
  claude: ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop", "StopFailure", "SubagentStop", "PreCompact"],
  codex: ["SessionStart", "Stop", "SessionEnd", "Interrupt", "PreCompact"],
};
const ACCOUNT_ID = /^[a-z]+:[a-z0-9][a-z0-9-]{0,31}$/;
const WORKER_ID = /^[0-9a-f]{8}$/;

export type HookFieldValue = string | number | boolean | null;

export interface SpoolLine {
  v: 1;
  received_at: string;
  provider: Provider;
  event: string;
  relay_job: string | null;
  relay_target: string | null;
  relay_worker: string | null;
  profile: string;
  fields: Partial<Record<(typeof HOOK_FIELDS)[number], HookFieldValue>>;
}

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

// Keeps the allowed fields whose values are plain: text, numbers, true, false or null. Text is cut
// to 1,024 characters.
export function keepFields(input: Record<string, unknown>): SpoolLine["fields"] {
  const kept: SpoolLine["fields"] = {};
  for (const name of HOOK_FIELDS) {
    const value = input[name];
    if (typeof value === "string") kept[name] = value.slice(0, MAX_TEXT);
    else if (value === null || ["number", "boolean"].includes(typeof value)) kept[name] = value as HookFieldValue;
  }
  return kept;
}

// A spool line read from the spool or from a request to the daemon, checked again because any
// program of the same user can write either: every value must have its format, and the fields go
// through the allow list once more. Returns null for anything else.
export function parseSpoolLine(value: unknown, now: Date): SpoolLine | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const line = value as Record<string, unknown>;
  const { provider, event, received_at: receivedAt, profile, fields } = line;
  if (line.v !== 1 || typeof provider !== "string" || !isProvider(provider)) return null;
  if (typeof event !== "string" || !EVENT_NAME.test(event)) return null;
  if (typeof receivedAt !== "string" || receivedAt.length > 64) return null;
  const time = Date.parse(receivedAt);
  if (Number.isNaN(time) || time > now.getTime() + MAX_CLOCK_AHEAD_MS) return null;
  const valid = (key: string, test: (text: string) => boolean) => line[key] === null || (typeof line[key] === "string" && test(line[key]));
  if (!valid("relay_job", isJobId) || !valid("relay_worker", (text) => WORKER_ID.test(text))) return null;
  if (!valid("relay_target", (text) => isTargetOf(provider, text))) return null;
  if (typeof profile !== "string" || profile.length > MAX_PROFILE || profile.includes("\0")) return null;
  if (profile !== "default" && !isAbsolute(profile)) return null;
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) return null;
  return {
    v: 1,
    received_at: new Date(time).toISOString(),
    provider,
    event,
    relay_job: line.relay_job as string | null,
    relay_target: line.relay_target as string | null,
    relay_worker: line.relay_worker as string | null,
    profile,
    fields: keepFields(fields as Record<string, unknown>),
  };
}

function isTargetOf(provider: Provider, text: string): boolean {
  return ACCOUNT_ID.test(text) && text.startsWith(`${provider}:`);
}

export function spoolLine(
  provider: Provider,
  event: string,
  input: Record<string, unknown>,
  env: Record<string, string | undefined>,
  receivedAt: Date,
): SpoolLine {
  const matching = (value: string | undefined, valid: (text: string) => boolean) => (value !== undefined && valid(value) ? value : null);
  const profile = env[provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"];
  return {
    v: 1,
    received_at: receivedAt.toISOString(),
    provider,
    event,
    relay_job: matching(env.RELAY_JOB, isJobId),
    relay_target: matching(env.RELAY_TARGET, (text) => isTargetOf(provider, text)),
    relay_worker: matching(env.RELAY_WORKER, (text) => WORKER_ID.test(text)),
    // Resolved in the hook's own folder, where a relative CLAUDE_CONFIG_DIR or CODEX_HOME applies.
    profile: profile ? resolve(profile) : "default",
    fields: keepFields(input),
  };
}
