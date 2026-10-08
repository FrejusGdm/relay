// Interactive Codex workers in the person's terminal. The session ID comes from relay's
// SessionStart hook, so it stays unknown until the person trusts relay's hooks in Codex. The prompt
// comes after "--", so Codex never reads it as an option or a subcommand.
import { join } from "node:path";
import type { Account } from "../../core/config/types";
import { HookFeed } from "../../hooks/feed";
import { now } from "../../platform/clock";
import { startInteractive } from "../process";
import { findProgram } from "../program";
import { tomlString } from "../text";
import type { StartRequest, StopResult, WorkerHandle } from "../types";
import { EventQueue, recordedArgs, recordWorkerReading, sessionIdForCommand, StopLimit, textForAgent, unsupportedOperation } from "../worker";
import { codexHookEvents } from "./hooks";

export async function startCodexInteractive(
  account: Account, request: StartRequest, adapterEnv: Record<string, string | undefined>,
): Promise<WorkerHandle> {
  const instructions = textForAgent(request.instructions);
  const prompt = request.prompt === undefined ? undefined : textForAgent(request.prompt);
  const path = findProgram("codex", adapterEnv);
  if (path === null) throw new Error("Codex is not installed.");
  const args = request.resumeSessionId === undefined ? [] : ["resume", sessionIdForCommand(request.resumeSessionId)];
  args.push("-C", request.cwd, "-c", `developer_instructions=${tomlString(instructions)}`);
  const instructionsAt = args.length - 1;
  if (prompt !== undefined) args.push("--", prompt);
  const queue = new EventQueue();
  const home = request.env.RELAY_HOME!;
  const feed = new HookFeed(home, join(request.cwd, ".relay", "events.jsonl"));
  const startedAt = now().getTime();
  let sessionSeen = false;
  let turnEnded = false;
  const child = startInteractive({ path, args, cwd: request.cwd, env: request.env });
  const poll = () => {
    for (const line of feed.fresh()) {
      if (!(Date.parse(line.received_at) >= startedAt) || line.provider !== "codex" || line.relay_worker !== request.workerId) continue;
      for (const event of codexHookEvents(line)) {
        if (event.kind === "session_started") {
          if (sessionSeen) continue;
          sessionSeen = true;
        }
        if (event.kind === "turn_completed") turnEnded = true;
        recordWorkerReading(home, account, event, "hook");
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
  let limit: StopLimit | undefined;
  const stop = async ({ timeoutMs = 30_000 }: { timeoutMs?: number } = {}): Promise<StopResult> => {
    if (!child.running()) {
      const status = await wait;
      return { how: "already_exited", exitCode: status.code, signal: status.signal, turnEnded };
    }
    if (stopping !== undefined) {
      limit?.shorten(timeoutMs);
      return stopping;
    }
    const stopLimit = new StopLimit(timeoutMs, () => child.signal("SIGKILL"));
    limit = stopLimit;
    stopping = (async (): Promise<StopResult> => {
      child.signal("SIGTERM");
      const status = await wait;
      stopLimit.clear();
      return { how: stopLimit.killed ? "killed" : "terminated", exitCode: status.code, signal: status.signal, turnEnded };
    })();
    return stopping;
  };
  return { workerId: request.workerId, transport: "codex-interactive", pid: child.pid,
    argv: recordedArgs(args, { [instructionsAt]: "developer_instructions=<instructions>", ...(prompt === undefined ? {} : { [args.length - 1]: "<prompt>" }) }),
    events: () => queue.events(),
    async send() { throw unsupportedOperation("Codex", "codex-interactive", "receive a message while it runs"); },
    async interrupt() { child.signal("SIGINT"); }, stop, wait: () => wait,
  };
}
