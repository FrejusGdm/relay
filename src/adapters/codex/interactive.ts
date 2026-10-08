// Interactive Codex workers in the person's terminal. The session ID comes from relay's
// SessionStart hook, so it stays unknown until the person trusts relay's hooks in Codex.
import type { Account } from "../../core/config/types";
import { readSpool } from "../../hooks/spool";
import { now } from "../../platform/clock";
import { startInteractive } from "../process";
import { findProgram } from "../program";
import { tomlString } from "../text";
import type { StartRequest, StopResult, WorkerHandle } from "../types";
import { EventQueue, recordWorkerReading, settlesWithin, textForAgent, unsupportedOperation } from "../worker";
import { codexHookEvents } from "./hooks";

export async function startCodexInteractive(
  account: Account, request: StartRequest, adapterEnv: Record<string, string | undefined>,
): Promise<WorkerHandle> {
  const instructions = textForAgent(request.instructions);
  const prompt = request.prompt === undefined ? undefined : textForAgent(request.prompt);
  const path = findProgram("codex", adapterEnv);
  if (path === null) throw new Error("Codex is not installed.");
  const args = request.resumeSessionId === undefined ? [] : ["resume", request.resumeSessionId];
  args.push("-C", request.cwd, "-c", `developer_instructions=${tomlString(instructions)}`);
  if (prompt !== undefined) args.push(prompt);
  const queue = new EventQueue();
  const home = request.env.RELAY_HOME!;
  const seen = new Map<string, number>();
  for (const line of readSpool(home)) {
    const key = JSON.stringify(line);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const startedAt = now().getTime();
  let sessionSeen = false;
  let turnEnded = false;
  const child = startInteractive({ path, args, cwd: request.cwd, env: request.env });
  const poll = () => {
    const counts = new Map<string, number>();
    for (const line of readSpool(home)) {
      const key = JSON.stringify(line);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count <= (seen.get(key) ?? 0)) continue;
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
    for (const [key, count] of counts) seen.set(key, Math.max(count, seen.get(key) ?? 0));
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
      return { how: "already_exited", exitCode: status.code, signal: status.signal, turnEnded };
    }
    if (stopping !== undefined) return stopping;
    stopping = (async (): Promise<StopResult> => {
      child.signal("SIGTERM");
      const finished = await settlesWithin(wait, timeoutMs);
      const killed = !finished && child.signal("SIGKILL");
      const status = await wait;
      return { how: killed ? "killed" : "terminated", exitCode: status.code, signal: status.signal, turnEnded };
    })();
    return stopping;
  };
  return { workerId: request.workerId, transport: "codex-interactive", pid: child.pid,
    events: () => queue.events(),
    async send() { throw unsupportedOperation("Codex", "codex-interactive", "receive a message while it runs"); },
    async interrupt() { child.signal("SIGINT"); }, stop, wait: () => wait,
  };
}
