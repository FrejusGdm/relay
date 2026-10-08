// Every event type the harness reads from <workdir>/.relay/events.jsonl (add-handoff-evaluation
// design decision 2; the envelope and fields are in docs/first-version-index.md, "Event types").

export const EventType = {
  commandRan: "command_ran",
  fileChanged: "file_changed",
  workerStarted: "worker_started",
  workerSessionIdentified: "worker_session_identified",
  workerEnded: "worker_ended",
  turnCompleted: "turn_completed",
  turnFailed: "turn_failed",
  handoff: "handoff",
} as const;

export interface RelayEvent {
  v: number;
  id: number;
  ts: string;
  job: string;
  type: string;
  actor: string;
  data: Record<string, unknown>;
}

// How often the harness reads new events while an agent works.
export const POLL_MS = 500;

// A step is one finished agent action: a command that finished or a file that was modified.
export function isStep(event: RelayEvent): boolean {
  return event.type === EventType.commandRan || event.type === EventType.fileChanged;
}

function parse(line: string): RelayEvent[] {
  try {
    const event = JSON.parse(line) as RelayEvent;
    if (typeof event !== "object" || event === null || typeof event.type !== "string") return [];
    return [{ ...event, data: typeof event.data === "object" && event.data !== null ? event.data : {} }];
  } catch {
    return [];
  }
}

// Reads the events added since the last call. It keeps a byte offset and leaves a last line
// without a line break for the next call, because relay may still be writing it.
export class EventReader {
  private offset = 0;

  constructor(readonly path: string) {}

  async read(): Promise<RelayEvent[]> {
    const file = Bun.file(this.path);
    if (!await file.exists()) return [];
    const bytes = new Uint8Array(await file.slice(this.offset).arrayBuffer());
    const end = bytes.lastIndexOf(10);
    if (end === -1) return [];
    this.offset += end + 1;
    return new TextDecoder().decode(bytes.subarray(0, end)).split("\n").flatMap(parse);
  }
}
