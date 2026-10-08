// JSON-RPC over lines for the Codex app server (add-provider-adapters, task 8.1): messages without
// the jsonrpc field, increasing request IDs, a time limit per request. Server requests reach their
// listeners and are never answered by this client.
import { number, object } from "../mapper";

type Notification = { method: string; params?: unknown };
type ServerRequest = Notification & { id: number | string };
type Pending = {
  method: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
};

export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly method: string) {
    super(message);
    this.name = "RpcError";
  }
}

export class RpcTimeout extends Error {
  constructor(readonly method: string) {
    super(`The Codex app server did not answer ${method} in time.`);
    this.name = "RpcTimeout";
  }
}

export class RpcClient {
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, Pending>();
  private readonly requests = new Set<(message: ServerRequest) => void>();
  private readonly notifications = new Set<(message: Notification) => void>();

  constructor(private readonly write: (line: string) => Promise<void>) {}

  request<T = unknown>(method: string, params?: unknown, options: { timeoutMs?: number } = {}): Promise<T> {
    if (this.closed) return Promise.reject(this.closedError(method));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.take(id);
        pending?.reject(new RpcTimeout(method));
      }, options.timeoutMs ?? 30_000);
      this.pending.set(id, { method, resolve: (value) => resolve(value as T), reject, timer });
      void this.send({ id, method, ...(params !== undefined ? { params } : {}) }).catch((error: unknown) => {
        this.take(id)?.reject(error);
      });
    });
  }

  notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) return Promise.reject(this.closedError(method));
    return this.send({ method, ...(params !== undefined ? { params } : {}) });
  }

  receive(message: unknown): void {
    if (this.closed || !object(message)) return;
    if (typeof message.method === "string") {
      const notification: Notification = { method: message.method, ...("params" in message ? { params: message.params } : {}) };
      if ("id" in message) {
        if (typeof message.id !== "string" && !number(message.id)) return;
        const request: ServerRequest = { ...notification, id: message.id };
        for (const handler of this.requests) handler(request);
      } else {
        for (const handler of this.notifications) handler(notification);
      }
      return;
    }
    if ("method" in message || !number(message.id)) return;
    if (!("error" in message) && !("result" in message)) return;
    if ("error" in message && (!object(message.error) || !number(message.error.code) || typeof message.error.message !== "string")) return;
    const pending = this.take(message.id);
    if (pending === undefined) return;
    if (object(message.error) && number(message.error.code) && typeof message.error.message === "string") {
      pending.reject(new RpcError(message.error.code, message.error.message, pending.method));
    } else pending.resolve(message.result);
  }

  onServerRequest(handler: (message: ServerRequest) => void): () => void {
    this.requests.add(handler);
    return () => { this.requests.delete(handler); };
  }

  onNotification(handler: (message: Notification) => void): () => void {
    this.notifications.add(handler);
    return () => { this.notifications.delete(handler); };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      this.take(id);
      pending.reject(this.closedError(pending.method));
    }
    this.requests.clear();
    this.notifications.clear();
  }

  private async send(message: unknown): Promise<void> {
    await this.write(JSON.stringify(message) + "\n");
  }

  private take(id: number): Pending | undefined {
    const pending = this.pending.get(id);
    if (pending !== undefined) { clearTimeout(pending.timer); this.pending.delete(id); }
    return pending;
  }

  private closedError(method: string): Error {
    return new Error(`The Codex app server closed before it answered ${method}.`);
  }
}
