import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Logger } from "../core/log";

export const T3_TOOLS = [
  "t3_project_list", "t3_thread_list", "t3_thread_read", "t3_thread_configure",
  "t3_thread_send", "t3_thread_interrupt", "orchestrator_capabilities",
] as const;
export type T3Tool = (typeof T3_TOOLS)[number];

export class T3Error extends Error {
  constructor(
    readonly kind: "not_answering" | "token_rejected" | "too_old" | "tool_failed" | "refused_tool",
    message: string,
  ) {
    super(message);
    this.name = "T3Error";
  }
}

export interface T3ClientOptions {
  url: string;
  token: () => Promise<string | null>;
  logger: Pick<Logger, "info" | "warn">;
  version: string;
  fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
}

export interface T3Client {
  connect(): Promise<{ serverVersion: string | null }>;
  call(tool: T3Tool, args: Record<string, unknown>, context?: { threadId?: string }): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export function createT3Client(options: T3ClientOptions): T3Client {
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let client: Client | null = null;
  let connecting: Promise<{ serverVersion: string | null }> | null = null;
  let serverVersion: string | null = null;
  let rejected = false;

  const expired = () => new T3Error("token_rejected", "The T3 Code connection has expired. Run relay t3 connect.");
  const unavailable = () => new T3Error("not_answering", `T3 Code is not answering at ${options.url}.`);
  const authenticatedFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    if (rejected) throw expired();
    let token: string | null;
    try {
      token = await options.token();
    } catch {
      throw new T3Error("token_rejected", "relay could not read the T3 Code credential store. Run relay t3 connect.");
    }
    if (token === null) {
      throw new T3Error("token_rejected", "relay is not connected to T3 Code. Run relay t3 connect.");
    }
    if (!/^[\x21-\x7e]+$/.test(token)) {
      throw new T3Error("token_rejected", "The T3 Code credential is invalid. Run relay t3 connect.");
    }
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    let response: Response;
    try {
      // A redirect must not send the credential to another address.
      response = await fetch(url, { ...init, headers, redirect: "error" });
    } catch {
      throw unavailable();
    }
    if (response.status === 401) {
      rejected = true;
      throw expired();
    }
    return response;
  };

  const closeClient = async (current: Client | null, reportErrors = false): Promise<void> => {
    try {
      await current?.close();
    } catch (error) {
      // Transport errors may contain response text, so they must not escape.
      if (reportErrors) throw rejected ? expired() : error instanceof T3Error ? error : unavailable();
    }
  };

  const connectOnce = async (): Promise<{ serverVersion: string | null }> => {
    if (rejected) throw expired();
    if (client) return { serverVersion };
    if (connecting) return connecting;
    connecting = (async () => {
      const next = new Client({ name: "relay", version: options.version });
      try {
        const transport = new StreamableHTTPClientTransport(new URL(options.url), { fetch: authenticatedFetch });
        await next.connect(transport);
        const { tools } = await next.listTools();
        if (T3_TOOLS.some((tool) => !tools.some((entry) => entry.name === tool))) {
          throw new T3Error("too_old", "This T3 Code build cannot be driven by relay. Install a current nightly build.");
        }
        serverVersion = next.getServerVersion()?.version ?? null;
        client = next;
        return { serverVersion };
      } catch (error) {
        await closeClient(next);
        if (rejected) throw expired();
        throw error instanceof T3Error ? error : unavailable();
      }
    })();
    try {
      return await connecting;
    } finally {
      connecting = null;
    }
  };

  return {
    connect: () => retry(connectOnce, sleep),
    async call(tool, args, context) {
      if (!(T3_TOOLS as readonly string[]).includes(tool)) {
        throw new T3Error("refused_tool", "relay refuses this T3 Code tool.");
      }
      return retry(async (attempt) => {
        let outcome: T3Error["kind"] | "ok" = "ok";
        try {
          await connectOnce();
          const result = await client!.callTool({ name: tool, arguments: args });
          if (result.isError || !isRecord(result.structuredContent)) {
            throw new T3Error("tool_failed", `T3 Code refused ${tool}.`);
          }
          return result.structuredContent;
        } catch (error) {
          const safe = rejected ? expired() : error instanceof T3Error ? error : new T3Error("tool_failed", `T3 Code refused ${tool}.`);
          outcome = safe.kind;
          // Only a tool's own refusal (isError) leaves the session usable. Any other failure, such as
          // T3 answering 404 to a session it forgot after a restart, makes the next attempt reconnect.
          if (!(error instanceof T3Error && error.kind === "tool_failed")) {
            const dead = client;
            client = null;
            serverVersion = null;
            await closeClient(dead);
          }
          throw safe;
        } finally {
          options.logger.info("t3 call", { tool, thread: context?.threadId ?? null, attempt, outcome });
        }
      }, sleep);
    },
    async close() {
      if (connecting) await connecting.catch(() => {});
      const current = client;
      client = null;
      serverVersion = null;
      const alreadyRejected = rejected;
      await closeClient(current, !alreadyRejected);
      if (!alreadyRejected && rejected) throw expired();
    },
  };
}

async function retry<T>(operation: (attempt: number) => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (!(error instanceof T3Error) || !["not_answering", "tool_failed"].includes(error.kind) || attempt === 3) throw error;
      await sleep(30_000);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
