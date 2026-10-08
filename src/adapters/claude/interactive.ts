// Interactive Claude Code workers in the person's terminal (the claude-code-adapter spec). relay
// learns what happens from its hooks every second, through src/hooks/feed.ts: the spool, and the
// job's events.jsonl for the events the daemon received.
import { join } from "node:path";
import type { Account } from "../../core/config/types";
import { HookFeed } from "../../hooks/feed";
import { now } from "../../platform/clock";
import { startInteractive } from "../process";
import { findProgram } from "../program";
import type { StartRequest, StopResult, WorkerHandle } from "../types";
import { EventQueue, recordWorkerReading, sessionIdForCommand, settlesWithin, textForAgent, unsupportedOperation } from "../worker";
import { claudeHookEvents } from "./hooks";

// After "--", Claude Code reads no more options, but its argument parser still runs a subcommand
// whose name equals the first remaining argument, so a one-word prompt such as "update" would run
// "claude update". A space at the end keeps such a prompt from matching a name.
function promptArgument(prompt: string): string {
  return /^\S+$/.test(prompt) ? `${prompt} ` : prompt;
}

export async function startClaudeInteractive(
  account: Account,
  request: StartRequest,
  adapterEnv: Record<string, string | undefined>,
): Promise<WorkerHandle> {
  const instructions = textForAgent(request.instructions);
  const prompt = request.prompt === undefined ? undefined : textForAgent(request.prompt);
  const path = findProgram("claude", adapterEnv);
  if (path === null) throw new Error("Claude Code is not installed.");
  const sessionId = request.resumeSessionId === undefined ? crypto.randomUUID() : sessionIdForCommand(request.resumeSessionId);
  const args = [request.resumeSessionId === undefined ? "--session-id" : "--resume", sessionId,
    "--append-system-prompt", instructions];
  if (prompt !== undefined) args.push("--", promptArgument(prompt));
  const queue = new EventQueue();
  const relayHome = request.env.RELAY_HOME!;
  const feed = new HookFeed(relayHome, join(request.cwd, ".relay", "events.jsonl"));
  const startedAt = now().getTime();
  const child = startInteractive({ path, args, cwd: request.cwd, env: request.env });
  queue.push({ kind: "session_started", providerSessionId: sessionId, source: "preset" });
  const poll = () => {
    for (const line of feed.fresh()) {
      if (!(Date.parse(line.received_at) >= startedAt) || line.provider !== "claude") continue;
      if (line.relay_worker !== request.workerId && line.fields.session_id !== sessionId) continue;
      for (const event of claudeHookEvents(line)) {
        recordWorkerReading(relayHome, account, event, "hook");
        queue.push(event);
      }
    }
  };
  const timer = setInterval(poll, 1000);
  const wait = child.exited.then((status) => {
    clearInterval(timer);
    poll();
    queue.push({ kind: "exited", ...status });
    return status;
  });
  let stopping: Promise<StopResult> | undefined;
  const stop = async ({ timeoutMs = 30_000 }: { timeoutMs?: number } = {}): Promise<StopResult> => {
    if (!child.running()) {
      const status = await wait;
      return { how: "already_exited", exitCode: status.code, signal: status.signal, turnEnded: false };
    }
    if (stopping !== undefined) return stopping;
    stopping = (async (): Promise<StopResult> => {
      child.signal("SIGTERM");
      const finished = await settlesWithin(wait, timeoutMs);
      const killed = !finished && child.signal("SIGKILL");
      const status = await wait;
      return { how: killed ? "killed" : "terminated", exitCode: status.code, signal: status.signal, turnEnded: false };
    })();
    return stopping;
  };
  return {
    workerId: request.workerId, transport: "claude-interactive", pid: child.pid, presetSessionId: sessionId,
    events: () => queue.events(),
    async send() { throw unsupportedOperation("Claude Code", "claude-interactive", "receive a message while it runs"); },
    async interrupt() { child.signal("SIGINT"); },
    stop, wait: () => wait,
  };
}
