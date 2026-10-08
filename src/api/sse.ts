// The live event stream, GET /v1/events (design.md decision 15). Every change is first written to
// the stream_events table, in the same transaction as the index change it describes, and its seq
// is the event's id. A client receives the rows after its position, then each new row as it is
// committed. A position the table no longer holds, or one ahead of the newest row (a cursor from
// a rebuilt database), gets a reset event first, so the client reloads with the GET endpoints.
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

  // Sends every committed row a client has not seen yet.
  publish(): void {
    for (const client of this.clients) this.sendNew(client);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  // The answer to GET /v1/events. `since` is the last id the client saw, or null for "only new
  // events".
  open(since: number | null, job: string | null): Response {
    if (this.closed) return errorResponse(503, "shutting_down", "The relay daemon is stopping.");
    if (this.clients.size >= this.maxClients) {
      return errorResponse(503, "too_many_streams", `The relay daemon already serves ${this.maxClients} event streams.`);
    }
    const newest = streamSeq(this.db);
    const oldest = this.db.query<{ seq: number | null }, []>("SELECT MIN(seq) AS seq FROM stream_events").get()?.seq ?? null;
    let cursor = since ?? newest;
    const reset = since !== null && (since > newest || (oldest !== null && since < oldest - 1));
    if (reset) cursor = (oldest ?? newest + 1) - 1;

    let client: Client;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        client = {
          job,
          cursor,
          controller,
          ping: setInterval(() => this.write(client, ": ping\n\n"), this.pingMs),
        };
        this.clients.add(client);
        this.write(client, "retry: 1000\n\n");
        if (reset) this.write(client, frame(null, "reset", JSON.stringify({ stream_epoch: streamEpoch(this.db) })));
        this.sendNew(client);
      },
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

  private sendNew(client: Client): void {
    for (;;) {
      const rows = this.db
        .query<Row, [number, number]>("SELECT seq, job_id, type, data FROM stream_events WHERE seq > ? ORDER BY seq LIMIT ?")
        .all(client.cursor, BATCH);
      for (const row of rows) {
        client.cursor = row.seq;
        if (client.job === null || row.job_id === null || row.job_id === client.job) {
          this.write(client, frame(row.seq, row.type, row.data));
        }
      }
      if (rows.length < BATCH) return;
    }
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
    clearInterval(client.ping);
    this.clients.delete(client);
  }
}

function frame(id: number | null, type: string, data: string): string {
  return `${id === null ? "" : `id: ${id}\n`}event: ${type}\ndata: ${data}\n\n`;
}
