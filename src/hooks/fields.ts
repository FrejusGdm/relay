// What relay keeps from a hook's input (add-provider-adapters, design decision 14; the same list as
// the provider-hooks capability of add-daemon-api-and-status). Everything else, such as
// tool_input, error_details or last_assistant_message, is dropped before anything is written.
import { resolve } from "node:path";
import { PROVIDERS, type Provider } from "../adapters/providers";
import { isJobId } from "../job/id";

export const HOOK_FIELDS = [
  "session_id", "cwd", "hook_event_name", "error", "notification_type", "reason", "source", "model", "turn_id",
] as const;
export const EVENT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

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

// Keeps the allowed fields whose values are plain: text, numbers, true, false or null.
export function keepFields(input: Record<string, unknown>): SpoolLine["fields"] {
  const kept: SpoolLine["fields"] = {};
  for (const name of HOOK_FIELDS) {
    const value = input[name];
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) kept[name] = value as HookFieldValue;
  }
  return kept;
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
    relay_target: matching(env.RELAY_TARGET, (text) => ACCOUNT_ID.test(text) && text.startsWith(`${provider}:`)),
    relay_worker: matching(env.RELAY_WORKER, (text) => WORKER_ID.test(text)),
    // Resolved in the hook's own folder, where a relative CLAUDE_CONFIG_DIR or CODEX_HOME applies.
    profile: profile ? resolve(profile) : "default",
    fields: keepFields(input),
  };
}
