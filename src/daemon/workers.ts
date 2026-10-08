// The headless workers the daemon started through POST /v1/jobs/{job}/switch (design.md decisions 7
// and 17). Each job's workers run under one job supervisor inside the daemon, so the agents are
// children of the daemon and their output goes to logs/workers/<job>-<worker>.log. They are listed
// in agents_running of GET /v1/version, and the daemon stops them when it stops.
import type { RunningAgent } from "../client/api-client";
import type { Logger } from "../core/log";

// What the daemon needs of a job supervisor (src/run/run.ts), set up by src/daemon/engines.ts.
export interface SupervisedJob {
  // The running worker, or null.
  running(): { worker_id: string; account: string } | null;
  // Resolves when the job's last worker has ended and relay has recorded it.
  done: Promise<unknown>;
  // Stops the running worker as SIGTERM would.
  stop(): Promise<void>;
  // Takes no more switch requests from relay switch and waits for the switch being served.
  finishSwitch(): Promise<void>;
}

const STOP_WAIT_MS = 30_000;

export class HeadlessWorkers {
  private readonly jobs = new Map<string, SupervisedJob>();

  constructor(private readonly log: Logger) {}

  add(jobId: string, job: SupervisedJob): void {
    this.jobs.set(jobId, job);
    void job.done
      .catch((error: unknown) => this.log.error("worker_supervision_failed", { job: jobId, error_name: error instanceof Error ? error.name : typeof error }))
      .finally(() => {
        if (this.jobs.get(jobId) === job) this.jobs.delete(jobId);
      });
  }

  running(): RunningAgent[] {
    return [...this.jobs].flatMap(([job, supervised]) => {
      const worker = supervised.running();
      return worker === null ? [] : [{ worker: worker.worker_id, target: worker.account, job }];
    });
  }

  // Lets switches that relay switch handed to the daemon's job supervisors finish, as running
  // operations do (design.md decision 7, step 3), and takes no new ones.
  async finishSwitches(): Promise<void> {
    await Promise.allSettled([...this.jobs.values()].map((job) => job.finishSwitch()));
  }

  // Stops every worker and waits up to 30 seconds for relay to record their ends (design.md
  // decision 7, step 4). A worker that a switch started meanwhile is stopped too.
  async stopAll(): Promise<void> {
    const deadline = Date.now() + STOP_WAIT_MS;
    while (this.jobs.size > 0 && Date.now() < deadline) {
      const jobs = [...this.jobs.values()];
      for (const job of jobs) void job.stop();
      await Promise.race([Promise.allSettled(jobs.map((job) => job.done)), Bun.sleep(Math.max(0, Math.min(500, deadline - Date.now())))]);
    }
    for (const job of this.jobs.keys()) this.log.warn("worker_still_running", { job });
  }
}
