// The small HTTP/1.1 layer of the local API (design.md decision 3). It accepts only what relay's
// clients send: one GET or POST per connection, a head of at most 16 KiB, a body of at most
// 64 KiB declared with Content-Length, all within 10 seconds. The parsed request becomes a
// standard Request for the router, and the router's Response is written back with
// Connection: close, either with Content-Length or, for an event stream, chunk by chunk as the
// stream produces them. Writes wait for the socket to drain when it cannot take more.
import { errorResponse, internalError, methodNotAllowed } from "./errors";

export const HEAD_LIMIT = 16 * 1024;
export const BODY_LIMIT = 64 * 1024;
export const REQUEST_DEADLINE_MS = 10_000;

// The connection as the parser sees it. write returns the number of bytes the socket accepted,
// or a negative number when the connection is closed.
export interface Transport {
  write(bytes: Uint8Array): number;
  end(): void;
}

export interface RequestDone {
  method: string | null;
  path: string | null;
  status: number;
  duration_ms: number;
}

export interface Http1Options {
  handle(request: Request): Promise<Response>;
  allow(path: string): string[];        // the methods the path accepts, for 405 answers
  onDone?(done: RequestDone): void;     // called once the answer is written
  deadlineMs?: number;
}

const REQUEST_LINE = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+) (\S+) HTTP\/1\.1$/;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const TARGET = /^\/[\x21-\x7e]*$/;
const FIELD_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
const LENGTH = /^\d{1,10}$/;
const OWN_HEADERS = new Set(["connection", "content-length", "transfer-encoding", "keep-alive"]);
const REASONS: Record<number, string> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  400: "Bad Request",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  411: "Length Required",
  413: "Content Too Large",
  422: "Unprocessable Content",
  431: "Request Header Fields Too Large",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

interface Head {
  method: string;
  target: string;
  headers: Headers;
  length: number;
  bodyStart: number;
}

const badRequest = (message: string) => errorResponse(400, "bad_request", message);

export class Http1Connection {
  // Received bytes live in one buffer that doubles when full, so a request sent one byte at a time
  // costs no more copying than one sent at once. It never grows past the head and body limits.
  private buffer: Buffer = Buffer.alloc(1024);
  private size = 0;
  private searchedTo = 0;
  private head: Head | null = null;
  private state: "reading" | "answering" | "closed" = "reading";
  private pending: Uint8Array[] = [];
  private waiting: (() => void)[] = [];
  private stream: { cancel(): Promise<void> } | null = null;
  private method: string | null = null;
  private path: string | null = null;
  private readonly started = performance.now();
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(
    private readonly transport: Transport,
    private readonly options: Http1Options,
  ) {
    this.timer = setTimeout(() => this.expire(), options.deadlineMs ?? REQUEST_DEADLINE_MS);
  }

  // Bytes from the socket. Anything after the first complete request is ignored.
  receive(chunk: Uint8Array): void {
    if (this.state !== "reading") return;
    this.append(chunk);
    const outcome = this.parse();
    if (outcome === null) return;
    this.state = "answering";
    clearTimeout(this.timer);
    void this.answer(outcome);
  }

  // The socket can take more bytes again.
  flush(): void {
    this.pump();
  }

  // The socket closed, from either side.
  closed(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    clearTimeout(this.timer);
    this.pending = [];
    this.wake();
    this.stream?.cancel().catch(() => {});
  }

  // Bytes past what the request can still need are dropped: past the largest possible request
  // before the head is complete, past the declared body afterwards.
  private append(chunk: Uint8Array): void {
    const limit = this.head === null ? HEAD_LIMIT + BODY_LIMIT : this.head.bodyStart + this.head.length;
    const bytes = chunk.subarray(0, Math.max(0, limit - this.size));
    if (this.size + bytes.length > this.buffer.length) {
      const grown = Buffer.alloc(Math.max(this.buffer.length * 2, this.size + bytes.length));
      this.buffer.copy(grown, 0, 0, this.size);
      this.buffer = grown;
    }
    this.buffer.set(bytes, this.size);
    this.size += bytes.length;
  }

  // Returns null while more bytes are needed, a Request when one is complete, or a Response that
  // refuses the request.
  private parse(): Request | Response | null {
    if (this.head === null) {
      // The search starts 3 bytes before the old end, where a split \r\n\r\n may begin.
      const end = this.buffer.subarray(0, this.size).indexOf("\r\n\r\n", Math.max(0, this.searchedTo - 3));
      this.searchedTo = this.size;
      if (end === -1 ? this.size > HEAD_LIMIT : end + 4 > HEAD_LIMIT) {
        return errorResponse(431, "headers_too_large", "Request headers are limited to 16 KiB.");
      }
      if (end === -1) return null;
      const head = this.parseHead(this.buffer.toString("latin1", 0, end), end + 4);
      if (head instanceof Response) return head;
      this.head = head;
      // The bytes after the head may hold more than the body; they are cut to the body's length.
      this.size = Math.min(this.size, head.bodyStart + head.length);
    }
    const { method, target, headers, length, bodyStart } = this.head;
    if (this.size - bodyStart < length) return null;
    try {
      const body = method === "POST" ? Buffer.from(this.buffer.subarray(bodyStart, bodyStart + length)) : undefined;
      return new Request(`http://relay${target}`, { method, headers, body });
    } catch {
      return badRequest("The request could not be read.");
    }
  }

  private parseHead(text: string, bodyStart: number): Head | Response {
    const [requestLine = "", ...fieldLines] = text.split("\r\n");
    const match = REQUEST_LINE.exec(requestLine);
    if (match === null) return badRequest("The request line is not valid HTTP/1.1.");
    const [, method, target] = match as unknown as [string, string, string];
    if (!TARGET.test(target)) return badRequest("The request target must be a path that starts with /.");
    this.method = method;
    this.path = target.split("?")[0]!;

    const headers = new Headers();
    for (const line of fieldLines) {
      const colon = line.indexOf(":");
      if (colon <= 0) return badRequest("Each header line needs a name, a colon and a value.");
      const name = line.slice(0, colon);
      const value = line.slice(colon + 1).replace(/^[ \t]+|[ \t]+$/g, "");
      if (!TOKEN.test(name) || !FIELD_VALUE.test(value)) return badRequest("A header has characters HTTP does not allow.");
      headers.append(name, value);
    }

    // A request from a web page is refused before anything else about it (the router repeats this).
    if (headers.has("origin")) return errorResponse(403, "origin_not_allowed", "relay does not accept requests from web pages.");
    if (method !== "GET" && method !== "POST") return methodNotAllowed(this.options.allow(this.path), this.path);
    if (headers.has("transfer-encoding")) return errorResponse(411, "length_required", "Send the body with Content-Length.");
    const declared = headers.get("content-length");
    let length = 0;
    if (declared !== null) {
      const values = declared.split(",").map((value) => value.trim());
      if (!values.every((value) => LENGTH.test(value) && value === values[0])) {
        return badRequest("The Content-Length header is not valid.");
      }
      length = Number(values[0]);
      if (length > BODY_LIMIT) return errorResponse(413, "payload_too_large", "Request bodies are limited to 64 KiB.");
    } else if (method === "POST") {
      return errorResponse(411, "length_required", "Send the body with Content-Length.");
    }
    if (method === "GET" && length > 0) return badRequest("A GET request cannot have a body.");
    return { method, target, headers, length, bodyStart };
  }

  private async answer(outcome: Request | Response): Promise<void> {
    let response: Response;
    try {
      response = outcome instanceof Response ? outcome : await this.options.handle(outcome);
    } catch {
      response = internalError();
    }
    try {
      await this.send(response);
    } catch {
      // The stream failed or the client went away; the connection is closed below either way.
    }
    this.options.onDone?.({
      method: this.method,
      path: this.path,
      status: response.status,
      duration_ms: Math.round(performance.now() - this.started),
    });
    if (this.state !== "closed") this.transport.end();
  }

  private async send(response: Response): Promise<void> {
    if (this.state === "closed") {
      await response.body?.cancel().catch(() => {});
      return;
    }
    const streamed = (response.headers.get("content-type") ?? "").startsWith("text/event-stream");
    let head = `HTTP/1.1 ${response.status} ${REASONS[response.status] ?? "Status"}\r\n`;
    for (const [name, value] of response.headers) {
      if (!OWN_HEADERS.has(name)) head += `${name}: ${value}\r\n`;
    }
    head += "Connection: close\r\n";
    if (!streamed || response.body === null) {
      const body = new Uint8Array(await response.arrayBuffer());
      await this.write(Buffer.from(`${head}Content-Length: ${body.length}\r\n\r\n`, "latin1"));
      if (body.length > 0) await this.write(body);
      return;
    }
    // The reader is registered before the first write, so a client that leaves at any point
    // cancels the stream.
    const reader = response.body.getReader();
    this.stream = reader;
    await this.write(Buffer.from(`${head}\r\n`, "latin1"));
    while (!this.isClosed()) {
      const { value, done } = await reader.read();
      if (done) return;
      await this.write(typeof value === "string" ? Buffer.from(value, "utf8") : value);
    }
  }

  // A method, so that TypeScript does not narrow the state across the awaits above.
  private isClosed(): boolean {
    return this.state === "closed";
  }

  // Resolves once the socket has taken every byte, or the connection closed.
  private write(bytes: Uint8Array): Promise<void> {
    if (this.state === "closed") return Promise.resolve();
    this.pending.push(bytes);
    this.pump();
    if (this.pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private pump(): void {
    while (this.pending.length > 0 && this.state !== "closed") {
      const next = this.pending[0]!;
      const written = this.transport.write(next);
      if (written < 0) {
        this.closed();
        return;
      }
      if (written < next.length) {
        this.pending[0] = next.subarray(written);
        return;
      }
      this.pending.shift();
    }
    if (this.pending.length === 0) this.wake();
  }

  private wake(): void {
    for (const resolve of this.waiting.splice(0)) resolve();
  }

  // The whole request did not arrive in time: the connection is closed without an answer.
  private expire(): void {
    if (this.state !== "reading") return;
    this.transport.end();
    this.closed();
  }
}
