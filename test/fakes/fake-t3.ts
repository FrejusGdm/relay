import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
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
  pairingCode?: string;
  expiresIn?: number;
}
export interface FakeT3 {
  url: string;
  pairingCode: string;
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
  const pairingCode = options.pairingCode ?? "relay-pairing";
  const issuedTokens = new Set<string>();
  const registrations = new Map<string, string[]>();
  const codes = new Map<string, { clientId: string; redirectUri: string; challenge: string }>();
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
  const handle = async (request: Request): Promise<Response> => {
    if (mode === "down") return Promise.reject(new Error("The fake T3 server is not answering."));
    const target = new URL(request.url);
    const issuer = target.origin;
    const json = (value: unknown, status = 200) => Response.json(value, { status });
    if (request.method === "GET" && ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"].includes(target.pathname)) {
      return json({ resource: `${issuer}/mcp`, authorization_servers: [issuer], bearer_methods_supported: ["header"] });
    }
    if (request.method === "GET" && ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"].includes(target.pathname)) {
      return json({
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`, response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"], code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"], authorization_response_iss_parameter_supported: true,
      });
    }
    if (request.method === "POST" && target.pathname === "/register") {
      let metadata: { redirect_uris?: unknown; client_name?: string };
      try { metadata = await request.json() as typeof metadata; }
      catch { return json({ error: "invalid_client_metadata" }, 400); }
      const redirects = metadata.redirect_uris;
      if (!Array.isArray(redirects) || redirects.length === 0 || redirects.some((value) => !loopbackRedirect(value))) {
        return json({ error: "invalid_redirect_uri" }, 400);
      }
      const clientId = crypto.randomUUID();
      registrations.set(clientId, redirects as string[]);
      return json({ client_id: clientId, client_name: metadata.client_name, redirect_uris: redirects,
        token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }, 201);
    }
    if (request.method === "GET" && target.pathname === "/authorize") {
      const params = target.searchParams;
      const clientId = params.get("client_id");
      const redirectUri = params.get("redirect_uri");
      const challenge = params.get("code_challenge");
      const state = params.get("state");
      if (params.get("pairing_code") !== pairingCode || params.get("response_type") !== "code"
        || params.get("code_challenge_method") !== "S256" || !clientId || !redirectUri || !challenge || !state
        || !registrations.get(clientId)?.some((registered) => sameLoopbackRedirect(registered, redirectUri))) {
        return json({ error: "invalid_request" }, 400);
      }
      const code = randomBytes(24).toString("hex");
      codes.set(code, { clientId, redirectUri, challenge });
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", state);
      callback.searchParams.set("iss", issuer);
      return new Response(null, { status: 302, headers: { Location: callback.toString() } });
    }
    if (request.method === "POST" && target.pathname === "/token") {
      const params = new URLSearchParams(await request.text());
      const code = params.get("code");
      const grant = code === null ? undefined : codes.get(code);
      // Codes are single-use, even after a failed exchange.
      if (code !== null) codes.delete(code);
      const verifier = params.get("code_verifier");
      if (params.get("grant_type") !== "authorization_code" || !grant || !verifier
        || params.get("client_id") !== grant.clientId || params.get("redirect_uri") !== grant.redirectUri
        || createHash("sha256").update(verifier).digest("base64url") !== grant.challenge) {
        return json({ error: "invalid_grant" }, 400);
      }
      const accessToken = `t3tok_${randomBytes(24).toString("hex")}`;
      issuedTokens.add(accessToken);
      return json({ access_token: accessToken, token_type: "Bearer", expires_in: options.expiresIn ?? 2_592_000 });
    }
    if (target.pathname !== "/mcp") return new Response(null, { status: 404 });
    const header = request.headers.get("Authorization");
    if (mode === "unauthorized" || (header !== `Bearer ${token}` && !issuedTokens.has(header?.replace(/^Bearer /, "") ?? ""))) {
      return new Response(null, { status: 401, headers: {
        "WWW-Authenticate": `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`,
      } });
    }
    if (header === null || !header.startsWith("Bearer ")) return new Response(null, { status: 401 });
    if (forgetSession) {
      forgetSession = false;
      return new Response("Session not found", { status: 404 });
    }
    return authorization.run(header, () => handler.fetch(request));
  };
  const safeError = () => new Response(null, { status: 500 });
  let listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle, error: safeError });
  // Keep the first port, so the address stays the same after the server comes back from "down".
  const port = listener.port;
  const url = `http://127.0.0.1:${port}/mcp`;
  let stopped = false;
  return {
    url, pairingCode,
    fetch: (target, init) => handle(new Request(target.toString(), init)),
    calls, threads,
    forgetSessionOnce() { forgetSession = true; },
    setMode(next) {
      if (next === "down") void listener.stop(true);
      else if (mode === "down" && !stopped) listener = Bun.serve({ hostname: "127.0.0.1", port, fetch: handle, error: safeError });
      mode = next;
    },
    async stop() {
      stopped = true;
      mode = "down";
      await listener.stop(true);
    },
  };
}

function loopbackRedirect(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      && !url.username && !url.password && !url.hash;
  } catch { return false; }
}

function sameLoopbackRedirect(registered: string, candidate: string): boolean {
  if (!loopbackRedirect(candidate)) return false;
  const left = new URL(registered);
  const right = new URL(candidate);
  // RFC 8252: loopback redirect registrations match independently of the chosen port.
  left.port = "";
  right.port = "";
  return left.href === right.href;
}

function statusOf(thread: FakeThread): FakeThreadRun["status"] | "idle" {
  return thread.runs[0]?.status ?? "idle";
}

function activeRun(thread: FakeThread): FakeThreadRun | undefined {
  const run = thread.runs[0];
  return run && ACTIVE.has(run.status) ? run : undefined;
}
