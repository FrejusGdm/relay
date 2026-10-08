// The hook events an interactive worker reads (add-daemon-api-and-status, design decision 18,
// "Hook events for interactive workers"). relay hook puts each event in one place: the spool when
// no daemon accepts it, or, through the daemon, the job's events.jsonl as a hook event that keeps
// the spool line's time, provider, event, RELAY_WORKER and allowed fields. A worker reads both, so
// it sees its hook events whether or not a daemon runs. Lines are counted by key, so a line that
// appears twice is handed out twice, while a spool line that the daemon drains into events.jsonl
// keeps its key and its count, and is handed out once. (A draining file is in neither place, so a
// line is never counted in both at once.)
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { keepFields, type SpoolLine } from "./fields";
import { readSpool } from "./spool";

export class HookFeed {
  private readonly seen = new Map<string, number>();
  // Every hook event of events.jsonl read so far; the file is read on from where the last read
  // ended.
  private hookEvents: SpoolLine[] = [];
  private offset = 0;
  private inode: number | null = null;

  // Everything already in the spool or in the job's events.jsonl when the worker starts is old.
  constructor(
    private readonly relayHome: string,
    private readonly eventsFile: string,
  ) {
    this.fresh();
  }

  // The lines that appeared since the feed was made or last asked, oldest first.
  fresh(): SpoolLine[] {
    const fresh: SpoolLine[] = [];
    const counts = new Map<string, number>();
    for (const line of [...readSpool(this.relayHome), ...this.readHookEvents()]) {
      const id = key(line);
      const count = (counts.get(id) ?? 0) + 1;
      counts.set(id, count);
      if (count > (this.seen.get(id) ?? 0)) fresh.push(line);
    }
    for (const [id, count] of counts) this.seen.set(id, Math.max(count, this.seen.get(id) ?? 0));
    return fresh;
  }

  private readHookEvents(): SpoolLine[] {
    this.hookEvents.push(...this.newHookEvents());
    return this.hookEvents;
  }

  // The hook events in the complete lines of events.jsonl after the last read. The file only
  // grows; a file that was replaced or cut is read again from the start.
  private newHookEvents(): SpoolLine[] {
    let fd: number;
    try {
      fd = openSync(this.eventsFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      return [];
    }
    let text: string;
    try {
      const stats = fstatSync(fd);
      if (!stats.isFile()) return [];
      if (stats.ino !== this.inode || stats.size < this.offset) {
        this.inode = stats.ino;
        this.offset = 0;
        this.hookEvents = [];
      }
      const buffer = Buffer.alloc(stats.size - this.offset);
      let length = 0;
      while (length < buffer.length) {
        const read = readSync(fd, buffer, length, buffer.length - length, this.offset + length);
        if (read === 0) break;
        length += read;
      }
      const end = buffer.subarray(0, length).lastIndexOf(0x0a) + 1;
      this.offset += end;
      text = buffer.toString("utf8", 0, end);
    } finally {
      closeSync(fd);
    }
    return text.split("\n").flatMap((raw) => {
      const line = hookEventLine(raw);
      return line === null ? [] : [line];
    });
  }
}

// A hook event of events.jsonl in the form of a spool line, or null for any other line.
function hookEventLine(raw: string): SpoolLine | null {
  if (!raw.includes('"type":"hook"')) return null;
  try {
    const event = JSON.parse(raw) as { type?: unknown; job?: unknown; data?: Record<string, unknown> };
    const data = event.data;
    if (event.type !== "hook" || typeof data !== "object" || data === null) return null;
    if (typeof data.received_at !== "string" || (data.provider !== "claude" && data.provider !== "codex") || typeof data.event !== "string") return null;
    return {
      v: 1,
      received_at: data.received_at,
      provider: data.provider,
      event: data.event,
      relay_job: typeof event.job === "string" ? event.job : null,
      relay_target: null,
      relay_worker: typeof data.relay_worker === "string" ? data.relay_worker : null,
      profile: "default",
      fields: keepFields(data),
    };
  } catch {
    return null;
  }
}

function key(line: SpoolLine): string {
  return JSON.stringify([line.received_at, line.provider, line.event, line.relay_worker, keepFields(line.fields)]);
}
