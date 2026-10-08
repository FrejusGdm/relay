// Headless Claude Code workers: claude -p with stream-JSON input and output (the claude-code-adapter
// spec). relay chooses the session ID, writes each message as one JSON line, closes the input when
// the last turn has finished, and interrupts with SIGINT, then SIGTERM and SIGKILL.
import type { Account } from "../../core/config/types";
import { now } from "../../platform/clock";
import { JsonLineParser } from "../lines";
import { object, stopped } from "../mapper";
import { startHeadless } from "../process";
import type { HeadlessProcess } from "../process";
import { findProgram } from "../program";
import type { StartRequest, StopResult, WorkerEvent, WorkerHandle } from "../types";
import { EventQueue, recordedArgs, recordWorkerReading, sessionIdForCommand, settlesWithin, textForAgent } from "../worker";
import { createClaudeStreamMapper } from "./stream";

export async function startClaudeHeadless(
  account: Account,
  request: StartRequest,
  adapterEnv: Record<string, string | undefined>,
  delays: { interruptMs: number; terminateMs: number } = { interruptMs: 10_000, terminateMs: 5000 },
): Promise<WorkerHandle> {
  if (request.prompt === undefined) throw new Error("A headless Claude Code worker needs a prompt.");
  const instructions = textForAgent(request.instructions);
  const prompt = textForAgent(request.prompt);
  const path = findProgram("claude", adapterEnv);
  if (path === null) throw new Error("Claude Code is not installed.");
  const sessionId = request.resumeSessionId === undefined ? crypto.randomUUID() : sessionIdForCommand(request.resumeSessionId);
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    request.resumeSessionId === undefined ? "--session-id" : "--resume", sessionId,
    "--permission-mode", request.permission === "read-only" ? "dontAsk" : "acceptEdits",
    "--permission-prompts", "none", "--append-system-prompt", instructions];
  if (request.model !== undefined) args.push("--model", request.model);
  const queue = new EventQueue();
  const parser = new JsonLineParser();
  const context = { interruptSent: false };
  const mapper = createClaudeStreamMapper(context);
  const relayHome = request.env.RELAY_HOME!;
  let child: HeadlessProcess | undefined;
  let written = 0;
  let results = 0;
  let inputClosed = false;
  let sessionSeen = false;
  let terminated = false;
  let killed = false;
  let stopping: Promise<StopResult> | undefined;
  let interruptTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const resultWaiters = new Set<() => void>();
  const publish = (event: WorkerEvent) => {
    if (event.kind === "session_started") sessionSeen = true;
    queue.push(event);
    recordWorkerReading(relayHome, account, event);
  };
  const clearEscalation = () => { clearTimeout(interruptTimer); clearTimeout(killTimer); };
  const endInput = () => { inputClosed = true; child?.closeInput(); };
  const resolveResults = () => { for (const done of resultWaiters) done(); resultWaiters.clear(); };
  const interrupt = async () => {
    if (child === undefined || !child.running() || context.interruptSent) return;
    context.interruptSent = true;
    child.signal("SIGINT");
    interruptTimer = setTimeout(() => {
      if (child?.signal("SIGTERM")) terminated = true;
      killTimer = setTimeout(() => { if (child?.signal("SIGKILL")) killed = true; }, delays.terminateMs);
    }, delays.interruptMs);
  };
  child = await startHeadless({
    path, args, cwd: request.cwd, env: request.env, input: "pipe", logPath: request.logPath,
    onLine(stream, line) {
      if (stream !== "out") return;
      const parsed = parser.parse(line);
      if (parsed === null) return;
      const value = parsed.value;
      const events = mapper.push(value);
      for (const event of events) {
        if (event.kind === "session_started" && event.providerSessionId !== sessionId) {
          child?.note(`Claude Code reported session ${event.providerSessionId}, not the session ID relay chose (${sessionId}).`);
        }
        publish(event);
      }
      if (object(value) && value.type === "result" && typeof value.is_error === "boolean") {
        results++;
        const interrupted = context.interruptSent;
        context.interruptSent = false;
        clearEscalation();
        resolveResults();
        if (!interrupted && results >= written) endInput();
      }
    },
    closingNotes: () => parser.skipped > 0 || mapper.unknown > 0
      ? [`ignored ${parser.skipped} line${parser.skipped === 1 ? "" : "s"} that ${parser.skipped === 1 ? "was" : "were"} not JSON and ${mapper.unknown} unknown event${mapper.unknown === 1 ? "" : "s"}.`] : [],
  });
  const agent = child;
  const wait = agent.exited.then((status) => {
    clearEscalation();
    resolveResults();
    const ended = mapper.end();
    if (written > results && !sessionSeen) publish({ kind: "session_started", providerSessionId: sessionId, source: "preset" });
    for (const event of ended) publish(event);
    if (written > results && ended.length === 0) publish(stopped(context));
    publish({ kind: "exited", ...status });
    return status;
  });
  const send = async (text: string) => {
    const cleaned = textForAgent(text);
    if (inputClosed || !agent.running() || stopping !== undefined) throw new Error("The agent's input is closed.");
    written++;
    try {
      await agent.write(`${JSON.stringify({ type: "user", message: { role: "user", content: cleaned }, parent_tool_use_id: null })}\n`);
    } catch (error) {
      written--;
      throw error;
    }
  };
  try { await send(prompt); }
  catch (error) { agent.signal("SIGKILL"); await wait; throw error; }
  const stop = async ({ timeoutMs = 30_000 }: { timeoutMs?: number } = {}): Promise<StopResult> => {
    if (!agent.running()) {
      const status = await wait;
      return { how: "already_exited", exitCode: status.code, signal: status.signal, turnEnded: written <= results };
    }
    if (stopping !== undefined) return stopping;
    const deadline = now().getTime() + Math.max(0, timeoutMs);
    stopping = (async (): Promise<StopResult> => {
      const deadlineTimer = setTimeout(() => {
        clearEscalation();
        if (agent.signal("SIGKILL")) killed = true;
      }, Math.max(0, timeoutMs));
      try {
        if (written > results) {
          let done!: () => void;
          const result = new Promise<void>((resolve) => { done = resolve; resultWaiters.add(done); });
          await interrupt();
          await settlesWithin(Promise.race([result, wait]), Math.min(delays.interruptMs, Math.max(0, deadline - now().getTime())));
          resultWaiters.delete(done);
        }
        endInput();
        if (!(await settlesWithin(wait, Math.max(0, deadline - now().getTime())))) {
          clearEscalation();
          if (agent.signal("SIGKILL")) killed = true;
        }
        const status = await wait;
        return { how: killed ? "killed" : terminated ? "terminated" : "clean", exitCode: status.code,
          signal: status.signal, turnEnded: written <= results };
      } finally { clearTimeout(deadlineTimer); clearEscalation(); }
    })();
    return stopping;
  };
  return { workerId: request.workerId, transport: "claude-print", pid: agent.pid, presetSessionId: sessionId,
    argv: recordedArgs(args, { [args.indexOf("--append-system-prompt") + 1]: "<instructions>" }),
    events: () => queue.events(), send, interrupt, stop, wait: () => wait };
}
