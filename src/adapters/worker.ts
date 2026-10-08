// What the Claude Code and Codex workers share: the event queue, the text check before anything
// leaves relay, refusal messages, and the recording of readings in availability.json.
import type { Account } from "../core/config/types";
import { readAvailability, recordReading } from "../accounts/availability";
import { now } from "../platform/clock";
import { removeInvisible } from "../text/invisible";
import { UnsupportedOperation } from "./types";
import type { AvailabilityState, Transport, WorkerEvent } from "./types";

export class EventQueue implements AsyncIterable<WorkerEvent> {
  private pending: WorkerEvent[] = [];
  private offset = 0;
  private ended = false;
  private claimed = false;
  private wake: (() => void) | undefined;

  push(event: WorkerEvent): void {
    if (this.ended) return;
    this.pending.push(event);
    if (event.kind === "exited") this.ended = true;
    this.wake?.();
  }

  events(): AsyncIterable<WorkerEvent> {
    if (this.claimed) throw new Error("Worker events can only be read once.");
    this.claimed = true;
    return this.read();
  }

  [Symbol.asyncIterator](): AsyncIterator<WorkerEvent> {
    return this.events()[Symbol.asyncIterator]();
  }

  private async *read(): AsyncGenerator<WorkerEvent> {
    while (true) {
      const event = this.pending[this.offset];
      if (event !== undefined) {
        this.offset++;
        if (this.offset === this.pending.length) {
          this.pending = [];
          this.offset = 0;
        }
        yield event;
        if (event.kind === "exited") return;
      } else {
        await new Promise<void>((done) => { this.wake = done; });
        this.wake = undefined;
      }
    }
  }
}

// `origin` is where turn_completed came from: the agent's output, or a hook of an interactive
// session.
export function recordWorkerReading(relayHome: string, account: Account, event: WorkerEvent, origin: "stream_event" | "hook" = "stream_event"): void {
  try {
    if (event.kind === "limit_update") {
      const state = event.state ?? (event.windows.some((window) => (window.usedPercent ?? 0) >= 100) ? "quota_exhausted" : "available");
      const resumed = event.source === "hook" && state === "available" && event.windows.length === 0;
      recordReading(relayHome, account, {
        state, windows: event.windows, retryAt: event.retryAt, observedAt: now(), source: event.source,
        ...(resumed ? { detail: "Claude Code continued after its reset." } : {}),
      });
    } else if (event.kind === "turn_completed") {
      recordReading(relayHome, account, {
        state: "available", windows: [], observedAt: now(), source: origin, detail: "The last turn finished normally",
      });
    } else if (event.kind === "turn_failed") {
      const states: Partial<Record<typeof event.reason, AvailabilityState>> = {
        usage_limit: "quota_exhausted", rate_limit: "rate_limited", auth: "unavailable", billing: "unavailable",
      };
      const state = states[event.reason];
      // A rate limit without a reset time takes the one of a full window from the latest status-line
      // reading, when there is one (the claude-code-adapter spec).
      let retryAt = event.retryAt;
      if (retryAt === undefined && event.reason === "rate_limit") {
        const full = readAvailability(relayHome, account).windows.filter((window) =>
          window.source === "status_line" && (window.usedPercent ?? 0) >= 100 && window.resetsAt !== undefined && window.resetsAt > now());
        if (full.length > 0) retryAt = new Date(Math.max(...full.map((window) => window.resetsAt!.getTime())));
      }
      if (state !== undefined) recordReading(relayHome, account, { state, windows: [], retryAt, observedAt: now(), source: event.source });
    }
  } catch {
    // Recording must not stop a worker when the disk cannot be written.
  }
}

export function textForAgent(text: string): string {
  const cleaned = removeInvisible(text).text;
  if (Buffer.byteLength(text, "utf8") > 100 * 1024 || Buffer.byteLength(cleaned, "utf8") > 100 * 1024) {
    throw new Error("The prompt is too long to pass on the command line; put it in a file under .relay/ and refer to it.");
  }
  return cleaned;
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Claude Code and Codex name their sessions with UUIDs. A session ID can come from a hook's input,
// which any program that runs as a hook controls, so only a UUID may reach a command line.
export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value);
}

export function sessionIdForCommand(id: string): string {
  if (!isSessionId(id)) throw new Error("The session ID to resume is not a UUID, so relay did not start the agent.");
  return id;
}

// The program's arguments as relay records them (design decision 16): the argument at each given
// position is replaced by its placeholder, such as <instructions> or <prompt>.
export function recordedArgs(args: string[], placeholders: Record<number, string>): string[] {
  return args.map((arg, index) => placeholders[index] ?? arg);
}

export function unsupportedOperation(displayName: string, transport: Transport, operation: string): UnsupportedOperation {
  const mode = transport === "claude-print" ? "claude -p" : transport === "codex-app-server" ? "app server"
    : transport === "codex-exec" ? "codex exec" : "interactive";
  return new UnsupportedOperation(`${displayName} in ${mode} mode cannot ${operation}.`);
}

// The time limit of a worker's stop: SIGKILL when it passes. A later stop with a shorter limit
// brings the SIGKILL forward, so that a second Ctrl+C or SIGTERM stops the agent at once.
export class StopLimit {
  killed = false;
  private deadline: number;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(timeoutMs: number, private readonly kill: () => boolean) {
    this.deadline = performance.now() + Math.max(0, timeoutMs);
    this.arm();
  }

  shorten(timeoutMs: number): void {
    const deadline = performance.now() + Math.max(0, timeoutMs);
    if (deadline >= this.deadline) return;
    this.deadline = deadline;
    this.arm();
  }

  remaining(): number {
    return Math.max(0, this.deadline - performance.now());
  }

  // Sends SIGKILL now, as the end of the limit would.
  expire(): void {
    this.clear();
    if (this.kill()) this.killed = true;
  }

  clear(): void {
    clearTimeout(this.timer);
  }

  private arm(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.expire(), this.remaining());
  }
}

export async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((done) => { timer = setTimeout(() => done(false), Math.max(0, timeoutMs)); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
