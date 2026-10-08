import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export type JobStatus = "queued" | "running" | "done" | "dead";

export interface Job {
  id: string;
  type: string;
  payload: unknown;
  status: JobStatus;
  attempts: number;
  runAt: number;
  lastError?: string;
}

export type Handler = (payload: unknown) => void | Promise<void>;

export interface QueueOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  now?: () => number;
}

export class JobQueue {
  private readonly jobs = new Map<string, Job>();
  private counter = 0;
  private path?: string;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(options: QueueOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 60000;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
  }

  static open(path: string, options: QueueOptions = {}): JobQueue {
    const queue = new JobQueue(options);
    queue.path = path;
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, "utf8")) as { counter: number; jobs: Job[] };
      queue.counter = data.counter;
      let recovered = false;
      for (const job of data.jobs) {
        if (job.status === "running") {
          job.status = "queued";
          recovered = true;
        }
        queue.jobs.set(job.id, job);
      }
      if (recovered) queue.save();
    }
    return queue;
  }

  private save(): void {
    if (this.path === undefined) return;
    writeFileSync(this.path + ".tmp", JSON.stringify({
      counter: this.counter, jobs: [...this.jobs.values()],
    }, null, 2) + "\n");
    renameSync(this.path + ".tmp", this.path);
  }

  enqueue(type: string, payload: unknown): string {
    const id = String(++this.counter);
    this.jobs.set(id, { id, type, payload, status: "queued", attempts: 0, runAt: this.now() });
    this.save();
    return id;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  deadLetters(): Job[] {
    return [...this.jobs.values()].filter((job) => job.status === "dead");
  }

  stats(): Record<JobStatus, number> {
    const counts = { queued: 0, running: 0, done: 0, dead: 0 };
    for (const job of this.jobs.values()) counts[job.status]++;
    return counts;
  }

  async runNext(handlers: Record<string, Handler>): Promise<Job | undefined> {
    const time = this.now();
    const job = [...this.jobs.values()].find((job) => job.status === "queued" && job.runAt <= time);
    if (!job) return undefined;
    job.status = "running";
    job.attempts++;
    this.save();
    try {
      const handler = Object.hasOwn(handlers, job.type) ? handlers[job.type] : undefined;
      if (!handler) throw new Error(`no handler for type ${job.type}`);
      await handler(job.payload);
      job.status = "done";
    } catch (error) {
      job.lastError = error instanceof Error ? error.message : String(error);
      if (job.attempts >= this.maxAttempts) job.status = "dead";
      else {
        job.status = "queued";
        const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (job.attempts - 1));
        job.runAt = this.now() + delay * (0.5 + this.random() / 2);
      }
    }
    this.save();
    return job;
  }
}
