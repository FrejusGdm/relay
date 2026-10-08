import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { T3_TOOLS } from "../../src/t3/client";

export interface FakeThreadRun {
  runId: string;
  status: "preparing" | "queued" | "starting" | "running" | "waiting" | "completed" | "interrupted" | "failed" | "cancelled";
  startedAt: string | null;
  completedAt: string | null;
}
export interface FakeThread {
  threadId: string;
  projectId: string;
  title: string;
  providerInstanceId: string;
  model: string;
  runtimeMode: "full-access";
  runs: FakeThreadRun[];
}
export interface FakeProject { id: string; title: string; workspaceRoot: string }
export interface FakeT3Options {
  projects?: FakeProject[];
  threads?: FakeThread[];
  instances?: { providerInstanceId: string; driverKind: "claude" | "codex" | "cursor"; models: string[] }[];
  token?: string;
  omitTools?: string[];
}
export interface FakeT3 {
  url: string;
  fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
  calls: { tool: string; args: Record<string, unknown>; authorization: string | null }[];
  threads: FakeThread[];
  setMode(mode: "normal" | "unauthorized" | "down"): void;
  forgetSessionOnce(): void;   // the next request gets 404, as T3 answers a session it no longer knows after a restart
  stop(): Promise<void>;
}

const ACTIVE = new Set(["preparing", "queued", "starting", "running", "waiting"]);

export async function startFakeT3(options: FakeT3Options = {}): Promise<FakeT3> {
  const token = options.token ?? `fake-token-${randomBytes(16).toString("hex")}`;
  const threads = options.threads ?? [];
  const calls: FakeT3["calls"] = [];
  const authorization = new AsyncLocalStorage<string>();
  const sent = new Map<string, Record<string, unknown>>();
  let mode: "normal" | "unauthorized" | "down" = "normal";
  let forgetSession = false;
  let sequence = 0;

  const schemas = {
    t3_project_list: z.object({}),
    t3_thread_list: z.object({ projectId: z.string().optional() }),
    t3_thread_read: z.object({ threadId: z.string() }),
    t3_thread_configure: z.object({ threadId: z.string(), modelSelection: z.object({ instanceId: z.string(), model: z.string() }) }),
    t3_thread_send: z.object({ threadId: z.string(), message: z.string(), mode: z.enum(["auto", "queue", "steer", "restart"]), clientRequestId: z.string() }),
    t3_thread_interrupt: z.object({ threadId: z.string(), runId: z.string().optional(), reason: z.string().optional() }),
    orchestrator_capabilities: z.object({}),
  };

  const runTool = (tool: string, args: Record<string, unknown>): Record<string, unknown> | null => {
    if (tool === "t3_project_list") return { projects: options.projects ?? [] };
    if (tool === "orchestrator_capabilities") {
      return { providers: (options.instances ?? []).map((instance) => ({
        providerInstanceId: instance.providerInstanceId, driverKind: instance.driverKind,
        models: instance.models.map((id) => ({ id })),
      })) };
    }
    if (tool === "t3_thread_list") {
      return { threads: threads.filter((thread) => args.projectId === undefined || thread.projectId === args.projectId).map((thread) => ({
        threadId: thread.threadId, title: thread.title, status: statusOf(thread),
        latestRunId: thread.runs[0]?.runId ?? null, providerInstanceId: thread.providerInstanceId,
        model: thread.model, runtimeMode: thread.runtimeMode,
        updatedAt: thread.runs[0]?.completedAt ?? thread.runs[0]?.startedAt ?? null,
      })) };
    }
    const thread = threads.find((item) => item.threadId === args.threadId);
    if (!thread) return null;
    if (tool === "t3_thread_read") {
      return {
        thread: {
          threadId: thread.threadId, status: statusOf(thread), activeRunId: activeRun(thread)?.runId ?? null,
          providerInstanceId: thread.providerInstanceId, model: thread.model, runtimeMode: thread.runtimeMode,
        },
        recentRuns: thread.runs.map((run) => ({ ...run, providerInstanceId: thread.providerInstanceId, model: thread.model })),
      };
    }
    if (tool === "t3_thread_configure") {
      const selection = args.modelSelection as { instanceId: string; model: string };
      thread.providerInstanceId = selection.instanceId;
      thread.model = selection.model;
      return { sequence: ++sequence };
    }
    if (tool === "t3_thread_send") {
      const key = JSON.stringify([thread.threadId, args.clientRequestId]);
      const previous = sent.get(key);
      if (previous) return previous;
      const id = ++sequence;
      const status = activeRun(thread) && args.mode !== "restart" ? "queued" : "running";
      const run: FakeThreadRun = { runId: `run-${id}`, status, startedAt: new Date().toISOString(), completedAt: null };
      thread.runs.unshift(run);
      const result = { threadId: thread.threadId, messageId: `message-${id}`, runId: run.runId, status, delivery: status === "queued" ? "queued" : "started" };
      sent.set(key, result);
      return result;
    }
    const run = activeRun(thread);
    if (!run || (args.runId !== undefined && args.runId !== run.runId)) return null;
    run.status = "interrupted";
    run.completedAt = new Date().toISOString();
    return { threadId: thread.threadId, runId: run.runId, status: run.status };
  };

  const buildServer = () => {
    const server = new McpServer({ name: "fake-t3", version: "1.0.0" });
    for (const tool of T3_TOOLS) {
      if (options.omitTools?.includes(tool)) continue;
      const inputSchema: z.ZodObject = schemas[tool];
      server.registerTool(tool, { description: `Fake ${tool} for relay tests.`, inputSchema }, async (args) => {
        calls.push({ tool, args, authorization: authorization.getStore() ?? null });
        const result = runTool(tool, args);
        if (result === null) return { content: [{ type: "text", text: "The thread or active run was not found." }], isError: true };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      });
    }
    return server;
  };
  const handler = createMcpHandler(buildServer);
  const handle = (request: Request): Promise<Response> => {
    if (mode === "down") return Promise.reject(new Error("The fake T3 server is not answering."));
    const header = request.headers.get("Authorization");
    if (mode === "unauthorized" || header !== `Bearer ${token}`) return Promise.resolve(new Response(null, { status: 401 }));
    if (forgetSession) {
      forgetSession = false;
      return Promise.resolve(new Response("Session not found", { status: 404 }));
    }
    return authorization.run(header, () => handler.fetch(request));
  };
  let listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });
  // Keep the first port, so the address stays the same after the server comes back from "down".
  const port = listener.port;
  const url = `http://127.0.0.1:${port}/mcp`;
  let stopped = false;
  return {
    url,
    fetch: (target, init) => handle(new Request(target.toString(), init)),
    calls, threads,
    forgetSessionOnce() { forgetSession = true; },
    setMode(next) {
      if (next === "down") void listener.stop(true);
      else if (mode === "down" && !stopped) listener = Bun.serve({ hostname: "127.0.0.1", port, fetch: handle });
      mode = next;
    },
    async stop() {
      stopped = true;
      mode = "down";
      await listener.stop(true);
    },
  };
}

function statusOf(thread: FakeThread): FakeThreadRun["status"] | "idle" {
  return thread.runs[0]?.status ?? "idle";
}

function activeRun(thread: FakeThread): FakeThreadRun | undefined {
  const run = thread.runs[0];
  return run && ACTIVE.has(run.status) ? run : undefined;
}
