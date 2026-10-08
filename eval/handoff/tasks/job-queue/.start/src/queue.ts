export type JobStatus = "queued" | "running" | "done" | "failed";

export interface Job {
  id: string;
  type: string;
  payload: unknown;
  status: JobStatus;
  attempts: number;
  lastError?: string;
}

export type Handler = (payload: unknown) => void | Promise<void>;

export class JobQueue {
  private readonly jobs = new Map<string, Job>();
  private counter = 0;

  enqueue(type: string, payload: unknown): string {
    const id = String(++this.counter);
    this.jobs.set(id, { id, type, payload, status: "queued", attempts: 0 });
    return id;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  async runNext(handlers: Record<string, Handler>): Promise<Job | undefined> {
    const job = [...this.jobs.values()].find((job) => job.status === "queued");
    if (!job) return undefined;
    job.status = "running";
    job.attempts++;
    const handler = handlers[job.type];
    if (!handler) throw new Error(`unknown job type ${job.type}`);
    try {
      await handler(job.payload);
      job.status = "done";
    } catch (error) {
      job.status = "failed";
      job.lastError = error instanceof Error ? error.message : String(error);
    }
    return job;
  }
}
