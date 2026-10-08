// Task 6.1: the event stream: replay, reset, the job filter, pings, the client limit, trimming,
// and the shutdown event; and the review fixes: no injected fields, rows read only when the client
// reads, and numbering above the old one after a rebuild.
import { afterAll, afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createRouter } from "../../src/api/router";
import { eventRoutes } from "../../src/api/routes/events";
import { EventStream } from "../../src/api/sse";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEvent, type RelayEvent } from "../../src/job/events";
import { applyEvent } from "../../src/state/apply-event";
import { databasePath, openDatabase, streamEpoch } from "../../src/state/db";
import { readEventsFrom } from "../../src/state/index-builder";
import { streamSeq } from "../../src/state/queries";
import { jobId, setUpJob } from "../helpers/job";
import { removeTempRelayHomes, spawnDaemon, tempRelayHome, testSocket, waitForDaemon } from "../helpers/relay-home";
import type { ScratchRepo } from "../helpers/scratch-repo";

interface Frame {
  id: number | null;
  event: string;
  data: unknown;
}

const opened: Database[] = [];
const scratches: ScratchRepo[] = [];
afterEach(() => {
  for (const scratch of scratches.splice(0).reverse()) scratch.cleanup();
});
afterAll(() => {
  for (const db of opened) db.close();
  removeTempRelayHomes();
});

function setUp(options: { pingMs?: number; maxClients?: number } = {}) {
  const relayHome = tempRelayHome();
  const { db } = openDatabase(relayHome);
  opened.push(db);
  // A new database numbers its events after this one.
  const base = streamSeq(db);
  const stream = new EventStream(db, options);
  const router = createRouter(eventRoutes(stream));
  const add = (type: string, jobId: string | null, data: unknown) => {
    db.transaction(() => stream.record({ jobId, type, data }))();
    stream.publish();
  };
  const connect = async (query = "", headers: Record<string, string> = {}) => {
    const response = await router.handle(new Request(`http://relay/v1/events${query}`, { headers }));
    return { response, read: reader(response) };
  };
  return { relayHome, db, base, stream, add, connect };
}

// Reads frames from an event stream; `next(n)` waits for n more frames (comments are frames
// with event ":").
function reader(response: Response) {
  let body: { read(): Promise<{ value?: Uint8Array; done: boolean }>; cancel(): Promise<void> } | undefined;
  let buffer = "";
  const frames: Frame[] = [];
  const next = async (count: number, ms = 3000): Promise<Frame[]> => {
    const deadline = Date.now() + ms;
    body ??= response.body?.getReader();
    while (frames.length < count) {
      if (body === undefined || Date.now() > deadline) throw new Error(`only ${frames.length} frames: ${buffer}`);
      const { value, done } = await Promise.race([body.read(), Bun.sleep(deadline - Date.now()).then(() => ({ value: undefined, done: false }))]);
      if (done) break;
      if (value !== undefined) buffer += new TextDecoder().decode(value);
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (block.startsWith("retry:")) continue;
        if (block.startsWith(":")) {
          frames.push({ id: null, event: ":", data: block });
          continue;
        }
        const field = (name: string) => block.split("\n").find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
        const id = field("id");
        frames.push({ id: id === undefined ? null : Number(id), event: field("event")!, data: JSON.parse(field("data")!) });
      }
    }
    return frames.splice(0, count);
  };
  return { next, cancel: async () => await (body ??= response.body?.getReader())?.cancel() };
}

test("the stream starts with retry and sends new events with increasing ids", async () => {
  const { base, add, connect } = setUp();
  const { response, read } = await connect();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toStartWith("text/event-stream");
  add("job", "3f9a2c1d", { id: "3f9a2c1d" });
  add("availability", null, { target: "claude:work" });
  expect(await read.next(2)).toEqual([
    { id: base + 1, event: "job", data: { id: "3f9a2c1d" } },
    { id: base + 2, event: "availability", data: { target: "claude:work" } },
  ]);
  await read.cancel();
});

test("reconnecting with Last-Event-ID replays exactly the events after it, in order; since wins over it", async () => {
  const { base, add, connect } = setUp();
  for (let n = 1; n <= 5; n++) add("job", "3f9a2c1d", { n });
  const resumed = await connect("", { "Last-Event-ID": String(base + 3) });
  expect((await resumed.read.next(2)).map((frame) => frame.id! - base)).toEqual([4, 5]);
  add("job", "3f9a2c1d", { n: 6 });
  expect((await resumed.read.next(1))[0]).toMatchObject({ id: base + 6, data: { n: 6 } });
  const both = await connect(`?since=${base + 4}`, { "Last-Event-ID": String(base + 1) });
  expect((await both.read.next(2)).map((frame) => frame.id! - base)).toEqual([5, 6]);
  await resumed.read.cancel();
  await both.read.cancel();
});

test("a position older than the retained rows, or ahead of the newest, gets reset first and then only new events", async () => {
  const { db, base, add, connect } = setUp();
  for (let n = 1; n <= 5; n++) add("job", "3f9a2c1d", { n });
  db.prepare("DELETE FROM stream_events WHERE seq < ?").run(base + 4);
  const old = await connect(`?since=${base + 1}`);
  const ahead = await connect(`?since=${base + 4180}`);
  const current = await connect(`?since=${base + 3}`);
  add("job", "3f9a2c1d", { n: 6 });
  // After a reset the client reloads with the GET endpoints, so rows 4 and 5 are not replayed.
  for (const client of [old, ahead]) {
    expect(await client.read.next(2)).toEqual([
      { id: null, event: "reset", data: { stream_epoch: streamEpoch(db) } },
      { id: base + 6, event: "job", data: { n: 6 } },
    ]);
  }
  // since=base+3 is the row just before the oldest retained one: no reset.
  expect((await current.read.next(3)).map((frame) => frame.id! - base)).toEqual([4, 5, 6]);
  for (const client of [old, ahead, current]) await client.read.cancel();
});

test("?job= filters out other jobs' events but keeps account events", async () => {
  const { base, add, connect } = setUp();
  const { read } = await connect("?job=3f9a2c1d");
  add("job", "aaaaaaaa", { id: "aaaaaaaa" });
  add("job", "3f9a2c1d", { id: "3f9a2c1d" });
  add("availability", null, { target: "claude:work" });
  expect((await read.next(2)).map((frame) => [frame.id! - base, frame.event])).toEqual([[2, "job"], [3, "availability"]]);
  await read.cancel();
});

test("a comment line is sent every ping interval, and bad positions are refused", async () => {
  const { connect } = setUp({ pingMs: 20 });
  const { read } = await connect();
  expect((await read.next(2)).map((frame) => frame.data)).toEqual([": ping", ": ping"]);
  await read.cancel();
  for (const position of ["-1", "99999999999999999", "9999999999999999"]) {
    const bad = await connect(`?since=${position}`);
    expect(bad.response.status).toBe(400);
    expect(((await bad.response.json()) as any).error.code).toBe("bad_request");
  }
});

test("the client after the limit gets 503, and a closed client frees its place", async () => {
  const { connect, stream } = setUp({ maxClients: 2 });
  const first = await connect();
  await connect();
  const refused = await connect();
  expect(refused.response.status).toBe(503);
  expect(((await refused.response.json()) as any).error.code).toBe("too_many_streams");
  await first.read.cancel();
  expect(stream.clientCount).toBe(1);
  expect((await connect()).response.status).toBe(200);
  stream.shutdown();
});

test("after every 1,000 inserts only the newest 10,000 rows are kept", () => {
  const { db, base, stream } = setUp();
  db.transaction(() => {
    for (let n = 0; n < 12_000; n++) stream.record({ jobId: null, type: "job", data: { n } });
  })();
  const range = db.query<{ low: number; high: number; rows: number }, []>("SELECT MIN(seq) AS low, MAX(seq) AS high, COUNT(*) AS rows FROM stream_events").get()!;
  expect(range).toEqual({ low: base + 2001, high: base + 12_000, rows: 10_000 });
});

test("an event type with a line break is not an event, and no field can be injected into the stream", async () => {
  const { relayHome, add, connect } = setUp();
  const injected = "x\nid: 999999\nevent: reset";
  const path = join(relayHome, "events.jsonl");
  const line = (id: number, type: string) => JSON.stringify({ v: 1, id, ts: new Date().toISOString(), job: "3f9a2c1d", type, actor: "relay", data: {} });
  writeFileSync(path, `${line(1, injected)}\n${line(2, "Job")}\n${line(3, "x".repeat(65))}\n${line(4, "future_type")}\n`);
  const read = readEventsFrom(path, 0);
  expect(read.events.map((event) => event.type)).toEqual(["future_type"]);
  expect(read.invalid).toHaveLength(3);

  // A change that still holds a line break (the second line of defence) is left out.
  const { read: client } = await connect();
  add(injected, "3f9a2c1d", {});
  add("job", "3f9a2c1d", { title: "a\nb" });
  const [frame] = await client.next(1);
  expect(frame).toMatchObject({ event: "job", data: { title: "a\nb" } });
  await client.cancel();
});

test("an unknown event type passes at most 16 KiB of data to the stream", () => {
  const { db } = setUp();
  const event = (data: Record<string, unknown>): RelayEvent => ({ v: 1, id: 1, ts: new Date().toISOString(), job: "3f9a2c1d", type: "future_type", actor: "relay", data });
  expect(applyEvent(db, "3f9a2c1d", event({ note: "small" })).changes).toEqual([{ jobId: "3f9a2c1d", type: "future_type", data: { note: "small" } }]);
  expect(applyEvent(db, "3f9a2c1d", event({ note: "x".repeat(17 * 1024) })).changes).toEqual([]);
});

test("rows are read from the table only when the client reads, so a client that does not read holds no backlog", async () => {
  const { db, base, add, connect } = setUp();
  const { read } = await connect();
  for (let n = 1; n <= 3000; n++) add("job", "3f9a2c1d", { n, padding: "x".repeat(1000) });
  // Rows the client has not asked for yet are deleted: a stream that queued every row at once
  // would still deliver them.
  db.prepare("DELETE FROM stream_events WHERE seq > ?").run(base + 10);
  expect((await read.next(10)).map((frame) => frame.id! - base)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  await expect(read.next(1, 300)).rejects.toThrow("only 0 frames");
  await read.cancel();
});

test("a rebuilt database numbers its events above the old ones, so an old position gets reset", async () => {
  const relayHome = tempRelayHome();
  const first = openDatabase(relayHome).db;
  const firstStream = new EventStream(first);
  first.transaction(() => {
    for (let n = 0; n < 50; n++) firstStream.record({ jobId: null, type: "job", data: { n } });
  })();
  const oldNewest = streamSeq(first);
  first.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${databasePath(relayHome)}${suffix}`, { force: true });

  const { db } = openDatabase(relayHome);
  opened.push(db);
  expect(streamSeq(db)).toBeGreaterThan(oldNewest);
  const stream = new EventStream(db);
  const response = await createRouter(eventRoutes(stream)).handle(new Request(`http://relay/v1/events?since=${oldNewest}`));
  const read = reader(response);
  db.transaction(() => stream.record({ jobId: null, type: "job", data: { n: "new" } }))();
  stream.publish();
  expect(await read.next(2)).toEqual([
    { id: null, event: "reset", data: { stream_epoch: streamEpoch(db) } },
    { id: streamSeq(db), event: "job", data: { n: "new" } },
  ]);
  await read.cancel();
});

test("a daemon sends an availability event for an event appended to a job, and shutdown before the stream ends", async () => {
  const scratch = await setUpJob();
  scratches.push(scratch);
  const daemon = spawnDaemon(scratch.relayHome);
  await waitForDaemon(scratch.relayHome);
  const response = await fetch("http://relay/v1/events", { unix: testSocket(scratch.relayHome) });
  const read = reader(response);
  await appendEvent({ id: jobId(scratch), worktreeRoot: scratch.repo, relayHome: scratch.relayHome }, "availability", {
    worker_id: null, target: "claude:work", status: "rate_limited", reason: "Claude Code reported a rate limit",
    retry_at: null, measured_at: new Date().toISOString(), source: "hook", windows: [],
  });
  const [availability] = await read.next(1);
  expect(availability).toMatchObject({
    event: "availability",
    data: { target: "claude:work", provider_name: "Claude Code", availability: { status: "rate_limited", source: "hook" }, usage: [] },
  });
  daemon.kill("SIGTERM");
  expect((await read.next(1))[0]).toEqual({ id: null, event: "shutdown", data: {} });
  expect(await daemon.exited).toBe(0);
}, 30_000);

