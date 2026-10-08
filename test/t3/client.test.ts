import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { LogFields } from "../../src/core/log";
import { createT3Client, T3Error, type T3ClientOptions, type T3Tool } from "../../src/t3/client";
import { startFakeT3 } from "../fakes/fake-t3";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setUp() {
  const token = randomBytes(16).toString("hex");
  const title = "A thread title that must stay private";
  const fake = await startFakeT3({ token, threads: [{
    threadId: "thread-1", projectId: "project-1", title, providerInstanceId: "claude",
    model: "sonnet", runtimeMode: "full-access", runs: [],
  }] });
  cleanup.push(() => fake.stop());
  const delays: number[] = [];
  const lines: { message: string; fields?: LogFields }[] = [];
  let requests = 0;
  const fetch: NonNullable<T3ClientOptions["fetch"]> = (url, init) => {
    requests++;
    return fake.fetch(url, init);
  };
  const options: T3ClientOptions = {
    url: fake.url, token: async () => token, version: "0.1.0", fetch,
    sleep: async (ms) => { delays.push(ms); },
    logger: {
      info: (message, fields) => { lines.push({ message, fields }); },
      warn: (message, fields) => { lines.push({ message, fields }); },
    },
  };
  const makeClient = (overrides: Partial<T3ClientOptions> = {}) => {
    const client = createT3Client({ ...options, ...overrides });
    cleanup.push(async () => {
      try {
        await client.close();
      } catch (error) {
        if (!(error instanceof T3Error)) throw new Error("The T3 client could not be closed.");
      }
    });
    return client;
  };
  return { fake, token, title, delays, lines, fetch, makeClient, requests: () => requests };
}

async function failure(operation: Promise<unknown>, kind: T3Error["kind"], message?: string): Promise<T3Error> {
  const error: unknown = await operation.catch((error: unknown) => error);
  expect(error instanceof T3Error).toBe(true);
  if (!(error instanceof T3Error)) throw new Error("The operation did not return a T3 error.");
  expect(error.kind).toBe(kind);
  if (message) expect(error.message).toBe(message);
  return error;
}

test("a refused tool makes no request, even before connecting", async () => {
  const setup = await setUp();
  const client = setup.makeClient();
  await failure(client.call("t3_thread_merge_back" as T3Tool, {}), "refused_tool");
  expect(setup.requests()).toBe(0);
  expect(setup.fake.calls).toHaveLength(0);
  expect(setup.delays).toEqual([]);
  expect(setup.lines).toEqual([]);
});

test("a null token makes no request and is not retried", async () => {
  const setup = await setUp();
  const client = setup.makeClient({ token: async () => null });
  await failure(client.call("t3_project_list", {}), "token_rejected", "relay is not connected to T3 Code. Run relay t3 connect.");
  expect(setup.requests()).toBe(0);
  expect(setup.delays).toEqual([]);
  expect(setup.lines.map((line) => line.fields?.outcome)).toEqual(["token_rejected"]);
});

test.each([false, true])("401 is not retried, with an existing connection: %s", async (connected) => {
  const setup = await setUp();
  const client = setup.makeClient();
  if (connected) await client.connect();
  setup.fake.setMode("unauthorized");
  const before = setup.requests();
  await failure(client.call("t3_project_list", {}), "token_rejected", "The T3 Code connection has expired. Run relay t3 connect.");
  expect(setup.requests() - before).toBe(1);
  expect(setup.delays).toEqual([]);
  expect(setup.lines).toEqual([{ message: "t3 call", fields: { tool: "t3_project_list", thread: null, attempt: 1, outcome: "token_rejected" } }]);
  await failure(client.call("t3_project_list", {}), "token_rejected");
  expect(setup.requests() - before).toBe(1);
});

test.each([false, true])("down is retried exactly twice, with an existing connection: %s", async (connected) => {
  const setup = await setUp();
  const client = setup.makeClient();
  if (connected) await client.connect();
  setup.fake.setMode("down");
  const before = setup.requests();
  await failure(client.call("t3_thread_read", { threadId: "thread-1" }, { threadId: "thread-1" }), "not_answering", `T3 Code is not answering at ${setup.fake.url}.`);
  expect(setup.requests() - before).toBe(3);
  expect(setup.delays).toEqual([30_000, 30_000]);
  expect(setup.lines.map((line) => line.fields)).toEqual([1, 2, 3].map((attempt) => ({ tool: "t3_thread_read", thread: "thread-1", attempt, outcome: "not_answering" })));
});

test("connect retries a down server exactly twice", async () => {
  const setup = await setUp();
  setup.fake.setMode("down");
  await failure(setup.makeClient().connect(), "not_answering");
  expect(setup.requests()).toBe(3);
  expect(setup.delays).toEqual([30_000, 30_000]);
});

test("isError is retried and only a safe tool error escapes", async () => {
  const setup = await setUp();
  const client = setup.makeClient();
  await client.connect();
  await failure(client.call("t3_thread_read", { threadId: "missing" }), "tool_failed", "T3 Code refused t3_thread_read.");
  expect(setup.fake.calls).toHaveLength(3);
  expect(setup.delays).toEqual([30_000, 30_000]);
  expect(setup.lines.map((line) => line.fields?.outcome)).toEqual(["tool_failed", "tool_failed", "tool_failed"]);
  expect(JSON.stringify(setup.lines).includes("The thread or active run was not found.")).toBe(false);
});

test("a successful call returns structuredContent and the server version", async () => {
  const setup = await setUp();
  const client = setup.makeClient();
  expect(await client.connect()).toEqual({ serverVersion: "1.0.0" });
  expect(await client.call("t3_project_list", {})).toEqual({ projects: [] });
  expect(setup.lines).toEqual([{ message: "t3 call", fields: { tool: "t3_project_list", thread: null, attempt: 1, outcome: "ok" } }]);
});

test("the logger receives no token, title, message text, arguments or results", async () => {
  const setup = await setUp();
  const message = "A private message sent only to T3";
  const client = setup.makeClient();
  await client.call("t3_thread_list", { projectId: "project-1" });
  await client.call("t3_thread_send", { threadId: "thread-1", message, mode: "auto", clientRequestId: "request-1" }, { threadId: "thread-1" });
  await failure(client.call("t3_thread_read", { threadId: "missing" }), "tool_failed");
  const text = JSON.stringify(setup.lines);
  for (const privateText of [setup.token, setup.title, message]) expect(text.includes(privateText)).toBe(false);
  for (const line of setup.lines) {
    expect(line.message).toBe("t3 call");
    expect(Object.keys(line.fields!).sort()).toEqual(["attempt", "outcome", "thread", "tool"]);
  }
});

test("a changed token is read from the caller for the next request", async () => {
  const setup = await setUp();
  let token: string | null = setup.token;
  const client = setup.makeClient({ token: async () => token });
  await client.connect();
  token = null;
  const before = setup.requests();
  await failure(client.call("t3_project_list", {}), "token_rejected");
  expect(setup.requests()).toBe(before);
  expect(setup.delays).toEqual([]);
});

test("after T3 stops answering, the next attempt reconnects instead of reusing the old session", async () => {
  const setup = await setUp();
  const client = setup.makeClient({
    sleep: async () => { setup.fake.setMode("normal"); },
  });
  await client.connect();
  setup.fake.setMode("down");
  const result = await client.call("t3_project_list", {});
  expect(Array.isArray(result.projects)).toBe(true);
  expect(setup.lines.map((line) => line.fields?.outcome)).toEqual(["not_answering", "ok"]);
});

test("a 404 for a session T3 forgot after a restart makes the next attempt reconnect", async () => {
  const setup = await setUp();
  const client = setup.makeClient();
  await client.connect();
  setup.fake.forgetSessionOnce();
  const result = await client.call("t3_project_list", {});
  expect(Array.isArray(result.projects)).toBe(true);
  expect(setup.lines.map((line) => line.fields?.outcome)).toEqual(["tool_failed", "ok"]);
  expect(setup.delays).toEqual([30_000]);
});
