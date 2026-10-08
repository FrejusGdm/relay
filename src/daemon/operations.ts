// One checkpoint or switch at a time per job, and the daemon's wait for them when it stops
// (design.md decisions 7 and 17). The engines also take the job lock, so an operation that a relay
// command in a terminal runs at the same time is refused too.
import type { Logger } from "../core/log";

export type OperationKind = "checkpoint" | "switch";

// Why an operation could not start.
export class OperationRefused extends Error {
  constructor(readonly reason: "busy" | "stopping", message: string) {
    super(message);
    this.name = "OperationRefused";
  }
}

const NOTICE_MS = 30_000;
const WORDS: Record<OperationKind, string> = { checkpoint: "checkpointed", switch: "switched" };

export class Operations {
  private readonly running = new Map<string, { kind: OperationKind; done: Promise<unknown> }>();
  private closing = false;

  // Runs `work` as the job's one operation. Throws OperationRefused, before `work` starts, when
  // the job has an operation already or the daemon is stopping.
  run<T>(jobId: string, kind: OperationKind, work: () => Promise<T>): Promise<T> {
    if (this.closing) throw new OperationRefused("stopping", "The relay daemon is stopping.");
    const current = this.running.get(jobId);
    if (current !== undefined) throw new OperationRefused("busy", `Job ${jobId} is already being ${WORDS[current.kind]}.`);
    const done = work().finally(() => this.running.delete(jobId));
    this.running.set(jobId, { kind, done });
    return done;
  }

  // Refuses new operations and waits for the running ones. After 30 seconds it logs which ones
  // still run and keeps waiting: an operation is never cut off in the middle of a git command.
  async finish(log: Logger): Promise<void> {
    this.closing = true;
    const all = () => Promise.allSettled([...this.running.values()].map((operation) => operation.done));
    const timer = setTimeout(() => {
      for (const [job, operation] of this.running) log.warn("operation_still_running", { job, operation: operation.kind });
    }, NOTICE_MS);
    try {
      while (this.running.size > 0) await all();
    } finally {
      clearTimeout(timer);
    }
  }
}
