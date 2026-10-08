import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createT3Client, T3Error, T3_TOOLS } from "../../src/t3/client";
import { startFakeT3, type FakeT3, type FakeThread } from "./fake-t3";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function thread(): FakeThread {
  return {
    threadId: "thread-1", projectId: "project-1", title: "A private thread title",
    providerInstanceId: "claude", model: "sonnet", runtimeMode: "full-access",
    runs: [{ runId: "run-1", status: "running", startedAt: "2026-10-08T00:00:00.000Z", completedAt: null }],
  };
}

async function connected(options: { omitTools?: string[] } = {}) {
  const token = randomBytes(16).toString("hex");
  const fake = await startFakeT3({
    token, threads: [thread()], omitTools: options.omitTools,
    projects: [{ id: "project-1", title: "A project", workspaceRoot: "/tmp/project" }],
    instances: [{ providerInstanceId: "codex", driverKind: "codex", models: ["gpt-6.1-sol"] }],
  });
  cleanup.push(() => fake.stop());
  const client = new Client({ name: "relay-test", version: "0.1.0" });
  cleanup.push(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(fake.url), {
    fetch: fake.fetch, requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return { fake, client, token };
}

test("the real MCP client lists the seven tools and reads a scripted failed run", async () => {
  const { fake, client, token } = await connected();
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name).sort()).toEqual([...T3_TOOLS].sort());
  const running = await client.callTool({ name: "t3_thread_read", arguments: { threadId: "thread-1" } });
  expect(running.structuredContent).toMatchObject({ thread: { status: "running", activeRunId: "run-1" } });
  fake.threads[0]!.runs[0]!.status = "failed";
  fake.threads[0]!.runs[0]!.completedAt = "2026-10-08T00:05:00.000Z";
  const failed = await client.callTool({ name: "t3_thread_read", arguments: { threadId: "thread-1" } });
  expect(failed.structuredContent).toMatchObject({
    thread: { threadId: "thread-1", status: "failed", activeRunId: null },
    recentRuns: [{ runId: "run-1", status: "failed", providerInstanceId: "claude", model: "sonnet", completedAt: "2026-10-08T00:05:00.000Z" }],
  });
  expect(fake.calls.map(({ tool, args }) => ({ tool, args }))).toEqual([
    { tool: "t3_thread_read", args: { threadId: "thread-1" } },
    { tool: "t3_thread_read", args: { threadId: "thread-1" } },
  ]);
  expect(fake.calls.every((call) => call.authorization === `Bearer ${token}`)).toBe(true);
});

test("all tool fields, project filtering, configuration, send deduplication and interruption", async () => {
  const { fake, client } = await connected();
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })).structuredContent;
  expect(await call("t3_project_list")).toEqual({ projects: [{ id: "project-1", title: "A project", workspaceRoot: "/tmp/project" }] });
  expect(await call("orchestrator_capabilities")).toEqual({ providers: [{ providerInstanceId: "codex", driverKind: "codex", models: [{ id: "gpt-6.1-sol" }] }] });
  expect(await call("t3_thread_list", { projectId: "other" })).toEqual({ threads: [] });
  expect(await call("t3_thread_list", { projectId: "project-1" })).toMatchObject({ threads: [{
    threadId: "thread-1", title: fake.threads[0]!.title, status: "running", latestRunId: "run-1",
    providerInstanceId: "claude", model: "sonnet", runtimeMode: "full-access", updatedAt: "2026-10-08T00:00:00.000Z",
  }] });
  expect(await call("t3_thread_interrupt", { threadId: "thread-1", runId: "run-1", reason: "The test ended the turn." })).toEqual({ threadId: "thread-1", runId: "run-1", status: "interrupted" });
  expect(await call("t3_thread_configure", { threadId: "thread-1", modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } })).toEqual({ sequence: 1 });
  expect(fake.threads[0]!.providerInstanceId).toBe("codex");
  expect(fake.threads[0]!.model).toBe("gpt-6.1-sol");
  expect(fake.threads[0]!.runtimeMode).toBe("full-access");
  const args = { threadId: "thread-1", message: "continue", mode: "auto", clientRequestId: "request-1" };
  const sent = await call("t3_thread_send", args);
  expect(sent).toEqual({ threadId: "thread-1", messageId: "message-2", runId: "run-2", status: "running", delivery: "started" });
  expect(await call("t3_thread_send", args)).toEqual(sent);
  expect(fake.threads[0]!.runs).toHaveLength(2);
  expect(fake.calls.filter((entry) => entry.tool === "t3_thread_send")).toHaveLength(2);
  fake.threads[0]!.runs = [];
  expect(await call("t3_thread_read", { threadId: "thread-1" })).toMatchObject({ thread: { status: "idle", activeRunId: null }, recentRuns: [] });
});

test("requests without a token get 401 through both fetch paths", async () => {
  const fake = await startFakeT3();
  cleanup.push(() => fake.stop());
  for (const fetch of [fake.fetch, globalThis.fetch]) {
    const response = await fetch(fake.url, { method: "POST" });
    expect(response.status).toBe(401);
  }
  expect(fake.calls).toHaveLength(0);
});

test("a missing configure tool makes relay reject the old build without retrying", async () => {
  const token = randomBytes(16).toString("hex");
  const fake: FakeT3 = await startFakeT3({ token, omitTools: ["t3_thread_configure"] });
  cleanup.push(() => fake.stop());
  const delays: number[] = [];
  const client = createT3Client({ url: fake.url, token: async () => token, version: "0.1.0", fetch: fake.fetch,
    logger: { info() {}, warn() {} }, sleep: async (ms) => { delays.push(ms); },
  });
  cleanup.push(() => client.close());
  const error = await client.connect().catch((error: unknown) => error);
  expect(error instanceof T3Error && error.kind === "too_old").toBe(true);
  expect(delays).toEqual([]);
});
