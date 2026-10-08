// Draining the hook spool (design.md decision 18). relay hook appends to spool/hooks.jsonl when the
// daemon does not accept an event in time. One second after the daemon starts, it renames the
// spool to spool/hooks.<pid>.draining, waits one more second, so a hook that opened the old file
// has finished writing, puts each line on the hook queue in order and deletes the file when the
// queue has processed them. Files left by a daemon that stopped while draining are processed
// first. A daemon that stops while draining leaves its file for the next start. While it runs,
// the daemon drains the spool again when a hook event arrives and every 2 seconds, so a line
// written while it was slow to answer does not wait for the next start.
import { lstatSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../core/log";
import { parseSpoolLine } from "../hooks/fields";
import type { HookQueue } from "../hooks/mapping";
import { readSpoolFile, spoolPath } from "../hooks/spool";

// relay hook stops appending above 10 MB, so a spool file is at most that plus one line.
const MAX_SPOOL_BYTES = 11 * 1024 * 1024;
const LEFTOVER = /^hooks\.\d+\.draining$/;

interface DrainOptions {
  relayHome: string;
  queue: HookQueue;
  log: Logger;
  startDelayMs?: number;   // 1 second; tests shorten it
  settleMs?: number;       // 1 second; tests shorten it
  intervalMs?: number;     // 2 seconds
}

export class SpoolDrain {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private wake: (() => void) | null = null;
  private stopped = false;
  private busy: Promise<void> | null = null;
  private again = false;

  constructor(private readonly opts: DrainOptions) {}

  start(): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.run();
      this.interval = setInterval(() => this.poke(), this.opts.intervalMs ?? 2000);
    }, this.opts.startDelayMs ?? 1000);
  }

  // Drains the spool when it holds lines. Before the first drain this does nothing, because the
  // first drain takes every line.
  poke(): void {
    if (this.timer !== null || this.stopped) return;
    if ((lstatSync(spoolPath(this.opts.relayHome), { throwIfNoEntry: false })?.size ?? 0) === 0) return;
    this.run();
  }

  // Stops queueing lines; the queue still processes the lines it was given.
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.interval !== null) clearInterval(this.interval);
    this.wake?.();
    while (this.busy !== null) await this.busy;
  }

  // One drain at a time; a drain asked for during one runs once more afterwards.
  private run(): void {
    if (this.busy !== null) {
      this.again = true;
      return;
    }
    this.busy = this.drain()
      .catch((error) => this.opts.log.error("spool_drain_failed", { error_name: error instanceof Error ? error.name : typeof error }))
      .finally(() => {
        this.busy = null;
        if (this.again && !this.stopped) {
          this.again = false;
          this.run();
        }
      });
  }

  private async drain(): Promise<void> {
    const folder = join(this.opts.relayHome, "spool");
    let names: string[];
    try {
      names = readdirSync(folder);
    } catch {
      return;
    }
    for (const name of names.filter((entry) => LEFTOVER.test(entry)).sort()) {
      if (!(await this.process(join(folder, name)))) return;
    }
    const draining = join(folder, `hooks.${process.pid}.draining`);
    try {
      renameSync(spoolPath(this.opts.relayHome), draining);
    } catch {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.opts.settleMs ?? 1000);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.wake = null;
    if (!this.stopped) await this.process(draining);
  }

  // Queues every valid line of one file, waits until they are processed and deletes the file.
  // Returns false, and keeps the file, when the daemon stopped before every line was queued.
  private async process(path: string): Promise<boolean> {
    const { queue, log } = this.opts;
    const text = readSpoolFile(path, MAX_SPOOL_BYTES);
    let queued = 0;
    let skipped = 0;
    for (const raw of text?.split("\n") ?? []) {
      if (this.stopped) return false;
      if (raw.trim() === "") continue;
      const line = parseLine(raw);
      if (line === null) {
        skipped++;
        continue;
      }
      while (!queue.offer(line)) await queue.idle();
      queued++;
    }
    await queue.idle();
    rmSync(path, { force: true });
    if (text === null) log.warn("spool_unreadable", { file: path });
    else log.info("spool_drained", { file: path, events: queued, skipped });
    return true;
  }
}

function parseLine(raw: string) {
  try {
    return parseSpoolLine(JSON.parse(raw), new Date());
  } catch {
    return null;
  }
}
