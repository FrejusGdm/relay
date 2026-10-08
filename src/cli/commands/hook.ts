import type { Provider } from "../../adapters/providers";
import { ExitCode } from "../exit-codes";
import type { CommandContext } from "./registry";

// The hook event names relay may log. Claude Code: its documented events
// (https://code.claude.com/docs/en/hooks). Codex: the events that add-provider-adapters installs
// (its design decision 13, from docs/research/provider-control-surfaces.md section 2.6).
const HOOK_EVENTS: Record<Provider, readonly string[]> = {
  claude: [
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Notification",
    "Stop",
    "StopFailure",
    "SubagentStop",
    "PreCompact",
  ],
  codex: ["SessionStart", "Stop", "SessionEnd", "Interrupt", "PreCompact"],
};

// Agents call `relay hook` and may wait on it, so it prints nothing and always succeeds. It reads
// standard input to the end so the agent never blocks on a full pipe, and discards it.
// The two arguments are logged only when they are a known provider and one of its documented
// events, so a value that an agent passes by mistake never reaches the log.
export async function hook(ctx: CommandContext): Promise<number> {
  if (!ctx.io.stdinIsTTY) await ctx.io.readStdinToEnd();
  const [provider, event] = ctx.positionals as [string, string];
  const events = Object.hasOwn(HOOK_EVENTS, provider) ? HOOK_EVENTS[provider as Provider] : null;
  ctx.log.info("hook ignored: not built yet", {
    provider: events ? provider : null,
    event: events?.includes(event) ? event : null,
  });
  return ExitCode.Ok;
}
