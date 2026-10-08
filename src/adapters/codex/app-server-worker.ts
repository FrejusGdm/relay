// Headless Codex workers through `codex app-server` (the codex-adapter spec): one app server per
// worker over standard input and output, the handshake, thread and turn requests, and approval
// requests that relay reports but never answers.
import type { Account } from "../../core/config/types";
import { JsonLineParser } from "../lines";
import { changedPaths, object } from "../mapper";
import { startHeadless } from "../process";
import type { HeadlessProcess } from "../process";
import { findProgram } from "../program";
import type { StartRequest, StopResult, WorkerEvent, WorkerHandle } from "../types";
import { EventQueue, recordWorkerReading, settlesWithin, textForAgent } from "../worker";
import { createAppServerMapper } from "./app-server";
import { startExecWorker } from "./exec";
import { APPROVAL_METHODS } from "./protocol";
import { RpcClient, RpcError } from "./rpc";
import { initializeCodex } from "./session";

const FALLBACK_NOTE = "The Codex app server did not start, so relay is using codex exec. Reset times will not be available for this run.";

export async function startAppServerWorker(
  account: Account, request: StartRequest, adapterEnv: Record<string, string | undefined>,
  delays: { initializeMs?: number; interruptMs?: number; requestMs?: number } = {},
): Promise<WorkerHandle> {
  if (request.prompt === undefined) throw new Error("A headless Codex worker needs a prompt.");
  const instructions = textForAgent(request.instructions);
  const prompt = textForAgent(request.prompt);
  const path = findProgram("codex", adapterEnv);
  if (path === null) throw new Error("Codex is not installed.");
  const queue = new EventQueue();
  const parser = new JsonLineParser();
  const context = { interruptSent: false };
  const mapper = createAppServerMapper(context);
  let child: HeadlessProcess | undefined;
  const rpc = new RpcClient((line) => child!.write(line));
  let threadId: string | undefined;
  let turnId: string | undefined;
  let turnEnded = false;
  let inputClosed = false;
  let pending = 0;
  let closeAfterTurn = false;
  let readingLimits: Promise<void> | undefined;
  let stopping: Promise<StopResult> | undefined;
  let reportExit = false;
  let exitReported = false;
  const turnWaiters = new Set<() => void>();
  const pathsByItem = new Map<string, string[]>();
  const limitsReadForTurn = new Set<string>();
  const publish = (event: WorkerEvent) => {
    recordWorkerReading(request.env.RELAY_HOME!, account, event);
    queue.push(event);
  };
  const endInput = () => { inputClosed = true; child?.closeInput(); };
  const maybeClose = () => {
    if (closeAfterTurn && pending === 0 && readingLimits === undefined && turnId === undefined) endInput();
  };
  const requestOptions = () => ({ timeoutMs: delays.requestMs ?? 30_000 });
  const failRequest = (error: unknown) => {
    mapper.end();
    turnId = undefined;
    turnEnded = true;
    publish({ kind: "turn_failed", reason: "other", message: (error instanceof Error ? error.message : String(error)).slice(0, 300), source: "stream_event" });
    endInput();
  };
  rpc.onServerRequest((message) => {
    if (!(APPROVAL_METHODS as readonly string[]).includes(message.method)) return;
    const params = object(message.params) ? message.params : {};
    const paths = changedPaths(params.changes) ?? (typeof params.itemId === "string" ? pathsByItem.get(params.itemId) : undefined)
      ?? (typeof params.path === "string" ? [params.path] : undefined);
    const summary = message.method === "item/commandExecution/requestApproval" && typeof params.command === "string"
      ? `run ${params.command}` : message.method === "item/fileChange/requestApproval" && paths !== undefined && paths.length > 0
        ? `change ${paths.join(", ")}` : message.method;
    publish({ kind: "approval_needed", requestId: String(message.id), summary });
  });
  try {
    child = await startHeadless({ path, args: ["app-server"], cwd: request.cwd, env: request.env,
      input: "pipe", logPath: request.logPath,
      onLine(stream, line) {
        if (stream !== "out") return;
        const parsed = parser.parse(line);
        if (parsed === null) return;
        const value = parsed.value;
        rpc.receive(value);
        for (const event of mapper.push(value)) publish(event);
        if (!object(value)) return;
        const params = object(value.params) ? value.params : {};
        const result = object(value.result) ? value.result : {};
        if (object(result.thread) && typeof result.thread.id === "string") threadId = result.thread.id;
        const turn = object(params.turn) ? params.turn : object(result.turn) ? result.turn : undefined;
        if (turn?.status === "inProgress" && typeof turn.id === "string") {
          turnId = turn.id;
          turnEnded = false;
        }
        if (value.method === "item/started" && object(params.item) && typeof params.item.id === "string") {
          const paths = changedPaths(params.item.changes);
          if (paths !== undefined) pathsByItem.set(params.item.id, paths);
        }
        if (value.method !== "turn/completed" || turn === undefined) return;
        if (turn.status !== "completed" && turn.status !== "failed" && turn.status !== "interrupted") return;
        if (turn.status === "failed" && (!object(turn.error) || typeof turn.error.message !== "string")) return;
        turnId = undefined;
        turnEnded = true;
        for (const done of turnWaiters) done();
        turnWaiters.clear();
        pathsByItem.clear();
        closeAfterTurn = turn.status !== "interrupted";
        if (turn.status === "failed" && object(turn.error) && turn.error.codexErrorInfo === "usageLimitExceeded"
          && (typeof turn.id !== "string" || !limitsReadForTurn.has(turn.id))) {
          if (typeof turn.id === "string") limitsReadForTurn.add(turn.id);
          readingLimits = rpc.request("account/rateLimits/read", undefined, requestOptions()).then(() => {}, () => {
            for (const event of mapper.end()) publish(event);
          }).finally(() => { readingLimits = undefined; maybeClose(); });
        }
        maybeClose();
      },
      closingNotes: () => parser.skipped > 0 || mapper.unknown > 0
        ? [`ignored ${parser.skipped} line${parser.skipped === 1 ? "" : "s"} that ${parser.skipped === 1 ? "was" : "were"} not JSON and ${mapper.unknown} unknown event${mapper.unknown === 1 ? "" : "s"}.`] : [],
    });
  } catch {
    rpc.close();
    return startExecWorker(account, request, adapterEnv, { note: FALLBACK_NOTE });
  }
  const agent = child;
  const wait = agent.exited.then((status) => {
    rpc.close();
    for (const done of turnWaiters) done();
    turnWaiters.clear();
    const ended = mapper.end();
    if (reportExit) {
      for (const event of ended) publish(event);
      publish({ kind: "exited", ...status });
      exitReported = true;
    }
    return status;
  });
  const fallback = async () => {
    endInput();
    if (!(await settlesWithin(wait, 1000))) agent.signal("SIGKILL");
    await wait;
    return startExecWorker(account, request, adapterEnv, { note: FALLBACK_NOTE });
  };
  try {
    await initializeCodex(rpc, delays.initializeMs ?? 15_000);
  } catch (error) {
    if (!(error instanceof RpcError)) return fallback();
    reportExit = true;
    failRequest(error);
  }
  if (!inputClosed) {
    const settings = { cwd: request.cwd, sandbox: request.permission === "read-only" ? "read-only" : "workspace-write",
      approvalPolicy: "never", developerInstructions: instructions,
      ...(request.model === undefined ? {} : { model: request.model }) };
    try {
      await rpc.request(request.resumeSessionId === undefined ? "thread/start" : "thread/resume",
        request.resumeSessionId === undefined ? settings : { threadId: request.resumeSessionId, ...settings }, requestOptions());
      if (threadId === undefined) throw new Error("The Codex app server did not return a thread ID.");
    } catch (error) {
      if (error instanceof RpcError && error.code === -32601 && error.method === "thread/start") return fallback();
      reportExit = true;
      failRequest(error);
    }
  }
  reportExit = true;
  // Count waiting messages before writing, so a finishing turn cannot close their input.
  let sending = Promise.resolve();
  const send = async (text: string): Promise<void> => {
    const cleaned = textForAgent(text);
    if (inputClosed || !agent.running() || stopping !== undefined) return Promise.reject(new Error("The agent's input is closed."));
    pending++;
    const operation = sending.then(async () => {
      await readingLimits;
      if (inputClosed || !agent.running()) throw new Error("The agent's input is closed.");
      const input = [{ type: "text", text: cleaned, text_elements: [] }];
      const active = turnId;
      if (active === undefined) { context.interruptSent = false; closeAfterTurn = false; turnEnded = false; }
      try {
        await rpc.request(active === undefined ? "turn/start" : "turn/steer",
          { threadId, input, ...(active === undefined ? {} : { expectedTurnId: active }) }, requestOptions());
      } catch (error) {
        if (active === undefined) failRequest(error);
        throw error;
      }
    }).finally(() => { pending--; maybeClose(); });
    sending = operation.catch(() => {});
    return operation;
  };
  const interrupt = async () => {
    if (!agent.running() || threadId === undefined || turnId === undefined || context.interruptSent) return;
    context.interruptSent = true;
    await rpc.request("turn/interrupt", { threadId, turnId }, requestOptions());
  };
  const stop = async ({ timeoutMs = 30_000 }: { timeoutMs?: number } = {}): Promise<StopResult> => {
    if (!agent.running()) {
      const status = await wait;
      return { how: "already_exited", exitCode: status.code, signal: status.signal, turnEnded };
    }
    if (stopping !== undefined) return stopping;
    stopping = (async (): Promise<StopResult> => {
      const deadline = performance.now() + Math.max(0, timeoutMs);
      let killed = false;
      const timer = setTimeout(() => { killed = agent.signal("SIGKILL") || killed; }, Math.max(0, timeoutMs));
      let done: (() => void) | undefined;
      try {
        if (turnId !== undefined) {
          const ended = new Promise<void>((resolve) => { done = resolve; turnWaiters.add(resolve); });
          void interrupt().catch(() => {});
          await settlesWithin(Promise.race([ended, wait]), Math.min(delays.interruptMs ?? 10_000, Math.max(0, deadline - performance.now())));
        }
        if (readingLimits !== undefined) await settlesWithin(readingLimits, Math.max(0, deadline - performance.now()));
        endInput();
        if (!(await settlesWithin(wait, Math.max(0, deadline - performance.now())))) killed = agent.signal("SIGKILL") || killed;
        const status = await wait;
        return { how: killed ? "killed" : "clean", exitCode: status.code, signal: status.signal, turnEnded };
      } finally {
        clearTimeout(timer);
        if (done !== undefined) turnWaiters.delete(done);
      }
    })();
    return stopping;
  };
  if (!inputClosed) await send(prompt).catch(() => {});
  if (!agent.running()) {
    const status = await wait;
    if (!exitReported) publish({ kind: "exited", ...status });
  }
  return { workerId: request.workerId, transport: "codex-app-server", pid: agent.pid, argv: ["app-server"],
    events: () => queue.events(), send, interrupt, stop, wait: () => wait,
  };
}
