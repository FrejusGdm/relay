// The live event stream, GET /v1/events (design.md decision 15). Every change is first written to
// the stream_events table, in the same transaction as the index change it describes, and its seq
// is the event's id. A client receives the rows after its position, then each new row as it is
// committed. A position the table no longer holds, or one ahead of the newest row (a cursor from
// a rebuilt database), gets a reset event first, so the client reloads with the GET endpoints,
// and then only the rows that come after the reset.
import type { Database } from "bun:sqlite";
import type { StreamChange } from "../state/apply-event";
import { streamEpoch } from "../state/db";
import { streamSeq } from "../state/queries";
import { errorResponse } from "./errors";

const KEEP_ROWS = 10_000;
const TRIM_EVERY = 1_000;
const BATCH = 500;
const encoder = new TextEncoder();

interface Row {
  seq: number;
  job_id: string | null;
  type: string;
  data: string;
}

interface Client {
  job: string | null;
  cursor: number;
  controller: ReadableStreamDefaultController<Uint8Array>;
  ping: ReturnType<typeof setInterval>;
  closed: boolean;
  // Resolves the read that waits for new rows.
  wake: (() => void) | null;
}

export interface StreamOptions {
  pingMs?: number;      // 15 seconds; tests shorten it
  maxClients?: number;  // 32
}

export class EventStream {
  private readonly clients = new Set<Client>();
  private inserts = 0;
  private closed = false;
  private readonly pingMs: number;
  private readonly maxClients: number;

  constructor(
    private readonly db: Database,
    options: StreamOptions = {},
  ) {
    this.pingMs = options.pingMs ?? 15_000;
    this.maxClients = options.maxClients ?? 32;
  }

  // Writes one change. Call it inside the transaction that makes the change, then publish() after
  // the transaction.
  record(change: StreamChange): void {
    if (change.data === null || change.data === undefined) return;
    this.db
      .prepare("INSERT INTO stream_events (job_id, type, data, ts) VALUES (?, ?, ?, ?)")
      .run(change.jobId, change.type, JSON.stringify(change.data), new Date().toISOString());
    this.inserts++;
    if (this.inserts % TRIM_EVERY === 0) {
      this.db.prepare("DELETE FROM stream_events WHERE seq <= (SELECT MAX(seq) FROM stream_events) - ?").run(KEEP_ROWS);
    }
  }

  // Wakes the clients that wait for new rows.
  publish(): void {
    for (const client of this.clients) this.wake(client);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  // The answer to GET /v1/events. `since` is the last id the client saw, or null for "only new
  // events". Rows are read from the table only when the client has taken what it was sent, so a
  // client that stops reading holds at most one batch in memory.
  open(since: number | null, job: string | null): Response {
    if (this.closed) return errorResponse(503, "shutting_down", "The relay daemon is stopping.");
    if (this.clients.size >= this.maxClients) {
      return errorResponse(503, "too_many_streams", `The relay daemon already serves ${this.maxClients} event streams.`);
    }
    const newest = streamSeq(this.db);
    const oldest = this.db.query<{ seq: number | null }, []>("SELECT MIN(seq) AS seq FROM stream_events").get()?.seq ?? null;
    // A position is kept when it is the newest, or not older than the row before the oldest one.
    const kept = since === null || since === newest || (since < newest && oldest !== null && since >= oldest - 1);
    // After a reset the client reloads everything with the GET endpoints, so old rows are not sent.
    const cursor = since !== null && kept ? since : newest;

    let client: Client;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        client = {
          job,
          cursor,
          controller,
          closed: false,
          wake: null,
          ping: setInterval(() => {
            // A client that is not reading gets no more pings than it has room for.
            if ((controller.desiredSize ?? 0) > 0) this.write(client, ": ping\n\n");
          }, this.pingMs),
        };
        this.clients.add(client);
        this.write(client, "retry: 1000\n\n");
        if (!kept) this.write(client, frame(null, "reset", JSON.stringify({ stream_epoch: streamEpoch(this.db) })));
      },
      pull: (controller) => this.pull(client, controller),
      cancel: () => this.drop(client),
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  // Sends shutdown to every client and ends the streams; later requests get 503.
  shutdown(): void {
    this.closed = true;
    for (const client of [...this.clients]) {
      this.write(client, frame(null, "shutdown", "{}"));
      this.drop(client);
      try {
        client.controller.close();
      } catch {
        // Already closed by the client.
      }
    }
  }

  // Called when the client's queue has room: sends the next batch of rows it has not seen, or
  // waits until publish() or shutdown() wakes it.
  private async pull(client: Client, controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    while (!client.closed) {
      const rows = this.db
        .query<Row, [number, number]>("SELECT seq, job_id, type, data FROM stream_events WHERE seq > ? ORDER BY seq LIMIT ?")
        .all(client.cursor, BATCH);
      if (rows.length === 0) {
        await new Promise<void>((resolve) => (client.wake = resolve));
        continue;
      }
      let text = "";
      for (const row of rows) {
        client.cursor = row.seq;
        if (client.job === null || row.job_id === null || row.job_id === client.job) text += frame(row.seq, row.type, row.data);
      }
      if (text !== "") {
        controller.enqueue(encoder.encode(text));
        return;
      }
    }
  }

  private wake(client: Client): void {
    const wake = client.wake;
    client.wake = null;
    wake?.();
  }

  private write(client: Client, text: string): void {
    try {
      client.controller.enqueue(encoder.encode(text));
    } catch {
      this.drop(client);
    }
  }

  private drop(client: Client | undefined): void {
    if (client === undefined) return;
    client.closed = true;
    clearInterval(client.ping);
    this.clients.delete(client);
    this.wake(client);
  }
}

// One event in the server-sent events format. A field value with a line break would start a new
// field, so such an event is left out (the event types are already checked when events.jsonl is
// read, and the data is JSON, which escapes line breaks).
function frame(id: number | null, type: string, data: string): string {
  if (/[\r\n]/.test(type) || /[\r\n]/.test(data)) return "";
  return `${id === null ? "" : `id: ${id}\n`}event: ${type}\ndata: ${data}\n\n`;
}
