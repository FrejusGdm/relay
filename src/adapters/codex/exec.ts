// Headless Codex workers through `codex exec --json`, the fallback when the app server cannot
// start or when RELAY_CODEX_TRANSPORT is set to exec, as the codex-adapter spec says. The prompt is
// an argument and standard input is at end of file.
import type { Account } from "../../core/config/types";
import { now } from "../../platform/clock";
import { JsonLineParser } from "../lines";
import { object } from "../mapper";
import { startHeadless } from "../process";
import { findProgram } from "../program";
import { resetTimeFromText } from "../reset-time";
import { tomlString } from "../text";
import type { StartRequest, StopResult, WorkerEvent, WorkerHandle } from "../types";
import { EventQueue, recordWorkerReading, settlesWithin, textForAgent, unsupportedOperation } from "../worker";
import { createExecMapper } from "./exec-stream";

// Reset text uses the child's local clock, which can differ from relay's clock.
function resetTimeForWorker(text: string, timeZone: string): Date | undefined {
  try {
    const format = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23",
      year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    const wallTime = (date: Date) => {
      const parts = format.formatToParts(date);
      const part = (type: string) => Number(parts.find((value) => value.type === type)?.value);
      return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
    };
    const current = new Date(wallTime(now()));
    const local = new Date(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate(),
      current.getUTCHours(), current.getUTCMinutes(), current.getUTCSeconds());
    const parsed = resetTimeFromText(text.match(/try again at (.+)$/im)?.[1] ?? "", local);
    if (parsed === undefined) return undefined;
    const target = Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), parsed.getHours(), parsed.getMinutes());
    let candidate = target;
    for (let index = 0; index < 4; index++) {
      const next = target - (wallTime(new Date(candidate)) - candidate);
      if (next === candidate) return new Date(candidate);
      candidate = next;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function startExecWorker(
  account: Account, request: StartRequest, adapterEnv: Record<string, string | undefined>,
  options: { note?: string; interruptMs?: number } = {},
): Promise<WorkerHandle> {
  if (request.prompt === undefined) throw new Error("A headless Codex worker needs a prompt.");
  const instructions = textForAgent(request.instructions);
  const prompt = textForAgent(request.prompt);
  const path = findProgram("codex", adapterEnv);
  if (path === null) throw new Error("Codex is not installed.");
  const sandbox = request.permission === "read-only" ? "read-only" : "workspace-write";
  const args = request.resumeSessionId === undefined
    ? ["exec", "--json", "-C", request.cwd, "-s", sandbox]
    : ["exec", "resume", request.resumeSessionId, "--json", "-c", `sandbox_mode=${tomlString(sandbox)}`];
  args.push("-c", `developer_instructions=${tomlString(instructions)}`);
  if (request.resumeSessionId === undefined && request.model !== undefined) args.push("-m", request.model);
  args.push(prompt);
  const queue = new EventQueue();
  const parser = new JsonLineParser();
  const context = { interruptSent: false };
  const mapper = createExecMapper(context);
  let turnEnded = false;
  let errorText: string | undefined;
  let stopping: Promise<StopResult> | undefined;
  const publish = (event: WorkerEvent, fromStream = false, failureText?: string) => {
    if (event.kind === "turn_failed" && event.reason === "usage_limit" && failureText !== undefined && request.env.TZ) {
      const retryAt = resetTimeForWorker(failureText, request.env.TZ);
      if (retryAt !== undefined) event = { ...event, retryAt };
    }
    if (fromStream && (event.kind === "turn_completed" || event.kind === "turn_failed")) turnEnded = true;
    recordWorkerReading(request.env.RELAY_HOME!, account, event);
    queue.push(event);
  };
  const child = await startHeadless({ path, args, cwd: request.cwd, env: request.env, input: "eof", logPath: request.logPath,
    onLine(stream, line) {
      if (stream !== "out") return;
      const parsed = parser.parse(line);
      if (parsed === null) return;
      const value = parsed.value;
      if (object(value) && value.type === "error" && typeof value.message === "string") errorText = value.message;
      const failureText = object(value) && object(value.error) && typeof value.error.message === "string" ? value.error.message : undefined;
      for (const event of mapper.push(value)) publish(event, true, failureText);
    },
    closingNotes: () => parser.skipped > 0 || mapper.unknown > 0
      ? [`ignored ${parser.skipped} line${parser.skipped === 1 ? "" : "s"} that ${parser.skipped === 1 ? "was" : "were"} not JSON and ${mapper.unknown} unknown event${mapper.unknown === 1 ? "" : "s"}.`] : [],
  });
  if (options.note !== undefined) child.note(options.note);
  const wait = child.exited.then((status) => {
    // The pure mapper ignores error records; an error alone still carries useful limit text.
    if (!turnEnded && !context.interruptSent && errorText !== undefined && /hit your usage limit/i.test(errorText)) {
      for (const event of mapper.push({ type: "turn.failed", error: { message: errorText } })) publish(event, true, errorText);
    }
    if (!turnEnded && !context.interruptSent && status.code === 1) {
      mapper.end();
      publish({ kind: "turn_failed", reason: "other", message: (errorText ?? "Codex stopped with exit code 1.").slice(0, 300), source: "message_text" });
    } else {
      const ended = mapper.end();
      for (const event of ended) publish(event);
      if (!turnEnded && context.interruptSent && ended.length === 0) {
        publish({ kind: "turn_failed", reason: "interrupted", message: "Interrupted.", source: "none" });
      }
    }
    if (context.interruptSent && status.code === 1 && status.signal === null) turnEnded = true;
    publish({ kind: "exited", ...status });
    return status;
  });
  const interrupt = async () => {
    if (!child.running() || turnEnded || context.interruptSent) return;
    context.interruptSent = true;
    child.signal("SIGINT");
  };
  const stop = async ({ timeoutMs = 30_000 }: { timeoutMs?: number } = {}): Promise<StopResult> => {
    if (!child.running()) {
      const status = await wait;
      return { how: "already_exited", exitCode: status.code, signal: status.signal, turnEnded };
    }
    if (stopping !== undefined) return stopping;
    stopping = (async (): Promise<StopResult> => {
      const deadline = performance.now() + Math.max(0, timeoutMs);
      let killed = false;
      let terminated = false;
      const timer = setTimeout(() => { killed = child.signal("SIGKILL") || killed; }, Math.max(0, timeoutMs));
      try {
        if (!turnEnded) {
          await interrupt();
          await settlesWithin(wait, Math.min(options.interruptMs ?? 10_000, Math.max(0, deadline - performance.now())));
        }
        if (child.running()) terminated = child.signal("SIGTERM");
        if (!(await settlesWithin(wait, Math.max(0, deadline - performance.now())))) killed = child.signal("SIGKILL") || killed;
        const status = await wait;
        return { how: killed ? "killed" : terminated ? "terminated" : "clean", exitCode: status.code, signal: status.signal, turnEnded };
      } finally { clearTimeout(timer); }
    })();
    return stopping;
  };
  return { workerId: request.workerId, transport: "codex-exec", pid: child.pid,
    events: () => queue.events(),
    async send() { throw unsupportedOperation("Codex", "codex-exec", "receive a message while it runs"); },
    interrupt, stop, wait: () => wait,
  };
}
