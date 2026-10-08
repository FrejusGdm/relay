// Task 3.2: the listener with the peer check, the router's version prefix and refusals, and
// GET /v1/version, over a real socket in a test relay folder.
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createRouter } from "../../src/api/router";
import { versionRoute } from "../../src/api/routes/version";
import { startApiServer } from "../../src/api/server";
import type { LogFields, Logger } from "../../src/core/log";
import { VERSION } from "../../src/core/version";
import { openDatabase, streamEpoch } from "../../src/state/db";
import { removeTempRelayHomes, tempRelayHome } from "../helpers/relay-home";

afterAll(removeTempRelayHomes);

interface Entry {
  level: string;
  msg: string;
  fields: LogFields;
}

function memoryLog(): Logger & { entries: Entry[] } {
  const entries: Entry[] = [];
  const add = (level: string) => (msg: string, fields: LogFields = {}) => entries.push({ level, msg, fields });
  return { entries, file: "memory", writing: true, setLevel() {}, debug: add("debug"), info: add("info"), warn: add("warn"), error: add("error") };
}

const STARTED = "2026-10-08T12:00:00.000Z";

function startServer(allowedUid?: number) {
  const socketPath = join(tempRelayHome(), "relay.sock");
  const log = memoryLog();
  const { db } = openDatabase(tempRelayHome());
  const router = createRouter([versionRoute({ pid: process.pid, started_at: STARTED, schema_version: 1 }, db)]);
  const server = startApiServer({ socketPath, router, log, allowedUid });
  return { socketPath, log, server, db };
}

// Sends raw bytes and collects everything the server writes until it closes the connection.
async function rawExchange(socketPath: string, bytes: string): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  let received = "";
  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_socket, chunk) {
        received += Buffer.from(chunk).toString("latin1");
      },
      close() {
        resolve(received);
      },
      error() {
        resolve(received);
      },
    },
  });
  socket.write(bytes);
  return promise;
}

describe("the API server", () => {
  const { socketPath, log, server, db } = startServer();
  afterAll(() => server.stop(100));
  const call = (path: string, init: RequestInit = {}) => fetch(`http://relay${path}`, { ...init, unix: socketPath });

  test("GET /v1/version returns the fields of decision 14 with Connection: close", async () => {
    const response = await call("/v1/version");
    expect(response.status).toBe(200);
    expect(response.headers.get("connection")).toBe("close");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("relay-stream-seq")).toBe("0");
    expect(await response.json()).toEqual({
      api: "v1",
      daemon_version: VERSION,
      pid: process.pid,
      started_at: STARTED,
      schema_version: 1,
      stream_epoch: streamEpoch(db),
      capabilities: ["accounts", "jobs", "events.sse"],
      agents_running: [],
    });
    expect(log.entries).toContainEqual(
      expect.objectContaining({ level: "debug", msg: "request", fields: expect.objectContaining({ method: "GET", path: "/v1/version", status: 200 }) }),
    );
  });

  test("GET /v2/jobs returns 404 unsupported_version", async () => {
    const response = await call("/v2/jobs");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "unsupported_version", message: "This relay daemon speaks v1.", supported: ["v1"] },
    });
  });

  test("an unknown path returns 404 not_found", async () => {
    const response = await call("/v1/widgets");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "not_found", message: "There is no /v1/widgets." } });
  });

  test("a request with an Origin header returns 403 origin_not_allowed", async () => {
    const response = await call("/v1/version", { headers: { Origin: "https://example.com" } });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "origin_not_allowed", message: "relay does not accept requests from web pages." },
    });
  });

  test("DELETE returns 405 with an Allow header", async () => {
    const jobs = await call("/v1/jobs/3f9a2c1d", { method: "DELETE" });
    expect(jobs.status).toBe(405);
    expect(jobs.headers.get("allow")).not.toBeNull();
    expect(((await jobs.json()) as { error: { code: string } }).error.code).toBe("method_not_allowed");
    const version = await call("/v1/version", { method: "DELETE" });
    expect(version.headers.get("allow")).toBe("GET");
    expect(await version.json()).toEqual({ error: { code: "method_not_allowed", message: "Use GET for /v1/version." } });
    const post = await call("/v1/version", { method: "POST", body: "{}" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
  });

  test("a POST body of 70,000 bytes returns 413 payload_too_large", async () => {
    const answer = await rawExchange(socketPath, "POST /v1/hooks/claude/Stop HTTP/1.1\r\nContent-Length: 70000\r\n\r\n");
    expect(answer).toStartWith("HTTP/1.1 413 ");
    expect(answer).toContain('"code":"payload_too_large"');
  });
});

describe("the peer check", () => {
  test("a connection from another user gets no response bytes and a peer_rejected warning", async () => {
    const uid = process.getuid!();
    const { socketPath, log, server } = startServer(uid + 1);
    try {
      expect(await rawExchange(socketPath, "GET /v1/version HTTP/1.1\r\n\r\n")).toBe("");
      expect(log.entries).toEqual([{ level: "warn", msg: "peer_rejected", fields: { uid } }]);
    } finally {
      await server.stop(100);
    }
  });
});

describe("stopping", () => {
  test("stop refuses new connections and lets an open request finish", async () => {
    const socketPath = join(tempRelayHome(), "relay.sock");
    const { promise: release, resolve } = Promise.withResolvers<void>();
    const router = createRouter([
      {
        method: "GET",
        path: "/v1/slow",
        handle: async () => {
          await release;
          return new Response("done");
        },
      },
    ]);
    const server = startApiServer({ socketPath, router, log: memoryLog() });
    const slow = fetch("http://relay/v1/slow", { unix: socketPath });
    await Bun.sleep(50);
    const stopped = server.stop(5000);
    await Bun.sleep(20);
    expect(await fetch("http://relay/v1/slow", { unix: socketPath }).then(() => "answered", () => "refused")).toBe("refused");
    resolve();
    expect(await (await slow).text()).toBe("done");
    await stopped;
  });
});
