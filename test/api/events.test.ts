// Task 6.1: the event stream: replay, reset, the job filter, pings, the client limit, trimming,
// and the shutdown event.
import { afterAll, afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createRouter } from "../../src/api/router";
import { eventRoutes } from "../../src/api/routes/events";
import { EventStream } from "../../src/api/sse";
import { appendEvent } from "../../src/job/events";
import { openDatabase, streamEpoch } from "../../src/state/db";
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
  const { db } = openDatabase(tempRelayHome());
  opened.push(db);
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
  return { db, stream, add, connect };
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
  const { add, connect } = setUp();
  const { response, read } = await connect();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toStartWith("text/event-stream");
  add("job", "3f9a2c1d", { id: "3f9a2c1d" });
  add("availability", null, { target: "claude:work" });
  expect(await read.next(2)).toEqual([
    { id: 1, event: "job", data: { id: "3f9a2c1d" } },
    { id: 2, event: "availability", data: { target: "claude:work" } },
  ]);
  await read.cancel();
});

test("reconnecting with Last-Event-ID replays exactly the events after it, in order; since wins over it", async () => {
  const { add, connect } = setUp();
  for (let n = 1; n <= 5; n++) add("job", "3f9a2c1d", { n });
  const resumed = await connect("", { "Last-Event-ID": "3" });
  expect((await resumed.read.next(2)).map((frame) => frame.id)).toEqual([4, 5]);
  add("job", "3f9a2c1d", { n: 6 });
  expect((await resumed.read.next(1))[0]).toMatchObject({ id: 6, data: { n: 6 } });
  const both = await connect("?since=4", { "Last-Event-ID": "1" });
  expect((await both.read.next(2)).map((frame) => frame.id)).toEqual([5, 6]);
  await resumed.read.cancel();
  await both.read.cancel();
});

test("a position older than the retained rows, or ahead of the newest, gets reset first", async () => {
  const { db, add, connect } = setUp();
  for (let n = 1; n <= 5; n++) add("job", "3f9a2c1d", { n });
  db.prepare("DELETE FROM stream_events WHERE seq < 4").run();
  const old = await connect("?since=1");
  const [reset, ...replayed] = await old.read.next(3);
  expect(reset).toEqual({ id: null, event: "reset", data: { stream_epoch: streamEpoch(db) } });
  expect(replayed.map((frame) => frame.id)).toEqual([4, 5]);

  const ahead = await connect("?since=4180");
  expect((await ahead.read.next(1))[0]).toMatchObject({ event: "reset", data: { stream_epoch: streamEpoch(db) } });
  const current = await connect("?since=3");
  add("job", "3f9a2c1d", { n: 6 });
  // since=3 is the row just before the oldest retained one: no reset.
  expect((await current.read.next(3)).map((frame) => frame.event)).toEqual(["job", "job", "job"]);
  for (const client of [old, ahead, current]) await client.read.cancel();
});

test("?job= filters out other jobs' events but keeps account events", async () => {
  const { add, connect } = setUp();
  const { read } = await connect("?job=3f9a2c1d");
  add("job", "aaaaaaaa", { id: "aaaaaaaa" });
  add("job", "3f9a2c1d", { id: "3f9a2c1d" });
  add("availability", null, { target: "claude:work" });
  expect((await read.next(2)).map((frame) => [frame.id, frame.event])).toEqual([[2, "job"], [3, "availability"]]);
  await read.cancel();
});

test("a comment line is sent every ping interval, and bad positions are refused", async () => {
  const { connect } = setUp({ pingMs: 20 });
  const { read } = await connect();
  expect((await read.next(2)).map((frame) => frame.data)).toEqual([": ping", ": ping"]);
  await read.cancel();
  const bad = await connect("?since=-1");
  expect(bad.response.status).toBe(400);
  expect(((await bad.response.json()) as any).error.code).toBe("bad_request");
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
  const { db, stream } = setUp();
  db.transaction(() => {
    for (let n = 0; n < 12_000; n++) stream.record({ jobId: null, type: "job", data: { n } });
  })();
  const range = db.query<{ low: number; high: number; rows: number }, []>("SELECT MIN(seq) AS low, MAX(seq) AS high, COUNT(*) AS rows FROM stream_events").get()!;
  expect(range).toEqual({ low: 2001, high: 12_000, rows: 10_000 });
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

