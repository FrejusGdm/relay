// Task 3.1: the HTTP/1.1 parser and response writer, fed bytes split at every position.
import { describe, expect, test } from "bun:test";
import { Http1Connection, type Http1Options, type Transport } from "../../src/api/http1";

interface Outcome {
  output: string;
  writes: string[];
  ended: boolean;
  requests: Request[];
  seen: string[];   // each dispatched request as JSON: method, URL, headers and body
}

// A transport that records what the connection writes. `accept` limits how many bytes each write
// takes; 0 makes the socket "full" until flush is called.
function fakeTransport(accept = Infinity) {
  const writes: string[] = [];
  let ended = false;
  let full = false;
  const { promise: done, resolve } = Promise.withResolvers<void>();
  const transport: Transport = {
    write(bytes) {
      if (ended) return -1;
      if (full) return 0;
      const taken = Math.min(bytes.length, accept);
      writes.push(Buffer.from(bytes.subarray(0, taken)).toString("latin1"));
      if (accept !== Infinity) full = true;
      return taken;
    },
    end() {
      ended = true;
      resolve();
    },
  };
  return { transport, writes, done, unblock: () => (full = false), isEnded: () => ended };
}

const okHandler = async (request: Request) => Response.json({ method: request.method, path: new URL(request.url).pathname });

async function feed(chunks: string[], options: Partial<Http1Options> = {}): Promise<Outcome> {
  const fake = fakeTransport();
  const requests: Request[] = [];
  const seen: string[] = [];
  const connection = new Http1Connection(fake.transport, {
    handle: async (request) => {
      requests.push(request);
      const body = await request.clone().text();
      seen.push(JSON.stringify({ method: request.method, url: request.url, headers: [...request.headers], body }));
      return (options.handle ?? okHandler)(request);
    },
    allow: options.allow ?? (() => ["GET"]),
    deadlineMs: options.deadlineMs,
  });
  for (const chunk of chunks) connection.receive(Buffer.from(chunk, "latin1"));
  await fake.done;
  return { output: fake.writes.join(""), writes: fake.writes, ended: fake.isEnded(), requests, seen };
}

// Every way to cut `bytes` into two pieces, plus one byte at a time.
function splits(bytes: string): string[][] {
  const result: string[][] = [[bytes], bytes.split("")];
  for (let at = 1; at < bytes.length; at++) result.push([bytes.slice(0, at), bytes.slice(at)]);
  return result;
}

async function sameAtEverySplit(bytes: string, options: Partial<Http1Options> = {}): Promise<Outcome> {
  const first = await feed([bytes], options);
  for (const chunks of splits(bytes)) {
    const outcome = await feed(chunks, options);
    expect(outcome.output).toBe(first.output);
    expect(outcome.seen).toEqual(first.seen);
  }
  return first;
}

function parseResponse(output: string) {
  const end = output.indexOf("\r\n\r\n");
  const [statusLine, ...headerLines] = output.slice(0, end).split("\r\n");
  const headers = Object.fromEntries(headerLines.map((line) => [line.slice(0, line.indexOf(":")).toLowerCase(), line.slice(line.indexOf(":") + 2)]));
  const body = output.slice(end + 4);
  const json = (headers["content-type"] ?? "").startsWith("application/json") ? JSON.parse(body) : null;
  return { statusLine, headers, body, json };
}

const errorCode = (output: string) => parseResponse(output).json.error.code;

describe("requests that are accepted", () => {
  test("a GET becomes the expected Request, at every split", async () => {
    const outcome = await sameAtEverySplit("GET /v1/version?x=1 HTTP/1.1\r\nHost: relay\r\nAccept: */*\r\n\r\n");
    const request = outcome.requests[0]!;
    expect(request.method).toBe("GET");
    expect(request.url).toBe("http://relay/v1/version?x=1");
    expect(request.headers.get("accept")).toBe("*/*");
    const response = parseResponse(outcome.output);
    expect(response.statusLine).toBe("HTTP/1.1 200 OK");
    expect(response.headers).toMatchObject({
      "content-type": "application/json;charset=utf-8",
      connection: "close",
      "content-length": String(Buffer.byteLength(response.body)),
    });
    expect(response.json).toEqual({ method: "GET", path: "/v1/version" });
    expect(outcome.ended).toBe(true);
  });

  test("a POST becomes a Request with its body, at every split; bytes after it are ignored", async () => {
    const body = JSON.stringify({ message: "before refactor" });
    const bytes = `POST /v1/jobs/3f9a2c1d/checkpoint HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
    const texts: string[] = [];
    const handle = async (request: Request) => {
      texts.push(await request.text());
      return new Response(null, { status: 201 });
    };
    const outcome = await sameAtEverySplit(`${bytes}GET /second HTTP/1.1\r\n\r\n`, { handle });
    expect(new Set(texts)).toEqual(new Set([body]));
    expect(outcome.requests[0]!.method).toBe("POST");
    expect(outcome.output).toBe("HTTP/1.1 201 Created\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });

  test("a head of exactly 16 KiB is accepted", async () => {
    const start = "GET / HTTP/1.1\r\nX-Fill: ";
    const fill = "a".repeat(16 * 1024 - start.length - 4);
    const outcome = await feed([`${start}${fill}\r\n\r\n`]);
    expect(parseResponse(outcome.output).statusLine).toBe("HTTP/1.1 200 OK");
  });
});

describe("requests that are refused", () => {
  test.each([
    ["a head over 16 KiB with its end", `GET / HTTP/1.1\r\nX-Fill: ${"a".repeat(16 * 1024)}\r\n\r\n`, 431, "headers_too_large"],
    ["a head over 16 KiB without its end", `GET / HTTP/1.1\r\nX-Fill: ${"a".repeat(16 * 1024 + 10)}`, 431, "headers_too_large"],
    ["a body over 64 KiB", "POST /v1/hooks/claude/Stop HTTP/1.1\r\nContent-Length: 70000\r\n\r\n", 413, "payload_too_large"],
    ["a length of 11 digits", "POST /v1/x HTTP/1.1\r\nContent-Length: 99999999999\r\n\r\n", 413, "payload_too_large"],
    ["a length too large for a number", `POST /v1/x HTTP/1.1\r\nContent-Length: ${"9".repeat(400)}\r\n\r\n`, 413, "payload_too_large"],
    ["Transfer-Encoding", "POST /v1/x HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n", 411, "length_required"],
    ["a POST without Content-Length", "POST /v1/x HTTP/1.1\r\nHost: relay\r\n\r\n", 411, "length_required"],
    ["a header line without a colon", "GET / HTTP/1.1\r\nHost relay\r\n\r\n", 400, "bad_request"],
    ["a control character in a header", "GET / HTTP/1.1\r\nX-A: a\u0001b\r\n\r\n", 400, "bad_request"],
    ["an invalid request line", "GET /\r\n\r\n", 400, "bad_request"],
    ["another HTTP version", "GET / HTTP/1.0\r\n\r\n", 400, "bad_request"],
    ["a target that is not a path", "GET http://relay/v1/version HTTP/1.1\r\n\r\n", 400, "bad_request"],
    ["two different lengths", "POST /v1/x HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\nab", 400, "bad_request"],
    ["a length that is not a number", "POST /v1/x HTTP/1.1\r\nContent-Length: -1\r\n\r\n", 400, "bad_request"],
    ["a GET with a body", "GET /v1/x HTTP/1.1\r\nContent-Length: 2\r\n\r\nab", 400, "bad_request"],
  ] as const)("%s gets %d %s at every split, and the handler never runs", async (_name, bytes, status, code) => {
    const outcome = await sameAtEverySplit(bytes);
    expect(parseResponse(outcome.output).statusLine).toStartWith(`HTTP/1.1 ${status} `);
    expect(errorCode(outcome.output)).toBe(code);
    expect(outcome.requests).toEqual([]);
    expect(outcome.ended).toBe(true);
  });

  test("a method other than GET or POST gets 405 with the path's Allow header", async () => {
    const outcome = await sameAtEverySplit("DELETE /v1/jobs/3f9a2c1d HTTP/1.1\r\n\r\n", { allow: () => ["GET"] });
    const response = parseResponse(outcome.output);
    expect(response.statusLine).toBe("HTTP/1.1 405 Method Not Allowed");
    expect(response.headers.allow).toBe("GET");
    expect(response.json).toEqual({ error: { code: "method_not_allowed", message: "Use GET for /v1/jobs/3f9a2c1d." } });
    expect(outcome.requests).toEqual([]);
  });

  test("a request with an Origin header gets 403 before its method is checked", async () => {
    const outcome = await sameAtEverySplit("DELETE /v1/version HTTP/1.1\r\nOrigin: https://example.com\r\n\r\n");
    expect(parseResponse(outcome.output).statusLine).toBe("HTTP/1.1 403 Forbidden");
    expect(errorCode(outcome.output)).toBe("origin_not_allowed");
  });

  test("a request that does not arrive within the deadline is closed without an answer", async () => {
    const outcome = await feed(["GET /v1/version HTTP/1.1\r\n"], { deadlineMs: 30 });
    expect(outcome).toMatchObject({ output: "", ended: true, requests: [] });
  });

  test("a handler that throws gets 500 internal_error", async () => {
    const outcome = await feed(["GET / HTTP/1.1\r\n\r\n"], {
      handle: async () => {
        throw new Error("boom");
      },
    });
    expect(parseResponse(outcome.output).statusLine).toBe("HTTP/1.1 500 Internal Server Error");
    expect(errorCode(outcome.output)).toBe("internal_error");
  });
});

describe("responses", () => {
  test("a streamed Response is written chunk by chunk, without Content-Length, as the stream produces them", async () => {
    const fake = fakeTransport();
    const { promise: started, resolve: startStream } = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
    const stream = new ReadableStream<Uint8Array>({ start: (controller) => startStream(controller) });
    const connection = new Http1Connection(fake.transport, {
      handle: async () => new Response(stream, { headers: { "Content-Type": "text/event-stream" } }),
      allow: () => ["GET"],
    });
    connection.receive(Buffer.from("GET /v1/events HTTP/1.1\r\n\r\n"));
    const controller = await started;
    await Bun.sleep(5);
    expect(fake.writes).toEqual(["HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nConnection: close\r\n\r\n"]);
    controller.enqueue(new TextEncoder().encode("id: 1\nevent: job\ndata: {}\n\n"));
    await Bun.sleep(5);
    expect(fake.writes.at(-1)).toBe("id: 1\nevent: job\ndata: {}\n\n");
    expect(fake.isEnded()).toBe(false);
    controller.enqueue(new TextEncoder().encode(": ping\n\n"));
    controller.close();
    await fake.done;
    expect(fake.writes.slice(1)).toEqual(["id: 1\nevent: job\ndata: {}\n\n", ": ping\n\n"]);
  });

  test("a client that goes away cancels the stream", async () => {
    const fake = fakeTransport();
    const { promise: cancelled, resolve } = Promise.withResolvers<void>();
    const stream = new ReadableStream<Uint8Array>({ cancel: () => resolve() });
    const connection = new Http1Connection(fake.transport, {
      handle: async () => new Response(stream, { headers: { "Content-Type": "text/event-stream" } }),
      allow: () => ["GET"],
    });
    connection.receive(Buffer.from("GET /v1/events HTTP/1.1\r\n\r\n"));
    await Bun.sleep(5);
    connection.closed();
    await cancelled;
  });

  test("a client that goes away before the handler answers cancels the stream it returns", async () => {
    const fake = fakeTransport();
    const { promise: cancelled, resolve } = Promise.withResolvers<void>();
    const { promise: answer, resolve: answerNow } = Promise.withResolvers<void>();
    const connection = new Http1Connection(fake.transport, {
      handle: async () => {
        await answer;
        const stream = new ReadableStream<Uint8Array>({ cancel: () => resolve() });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
      },
      allow: () => ["GET"],
    });
    connection.receive(Buffer.from("GET /v1/events HTTP/1.1\r\n\r\n"));
    connection.closed();
    answerNow();
    await cancelled;
    expect(fake.writes).toEqual([]);
  });

  test("a request sent one byte at a time with the largest body is read whole", async () => {
    const body = "b".repeat(64 * 1024);
    const bytes = `POST /v1/x HTTP/1.1\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
    const texts: string[] = [];
    const handle = async (request: Request) => {
      texts.push(await request.text());
      return new Response(null, { status: 202 });
    };
    const whole = await feed([bytes], { handle });
    const byteByByte = await feed(bytes.split(""), { handle });
    expect(byteByByte.output).toBe(whole.output);
    expect(texts).toEqual([body, body]);
  });

  test("writes wait for the socket to drain when it takes only part of the bytes", async () => {
    const fake = fakeTransport(7);
    const body = "x".repeat(100);
    const connection = new Http1Connection(fake.transport, {
      handle: async () => new Response(body),
      allow: () => ["GET"],
    });
    connection.receive(Buffer.from("GET / HTTP/1.1\r\n\r\n"));
    let rounds = 0;
    while (!fake.isEnded() && rounds < 1000) {
      await Bun.sleep(0);
      fake.unblock();
      connection.flush();
      rounds++;
    }
    expect(fake.isEnded()).toBe(true);
    expect(fake.writes.every((piece) => piece.length <= 7)).toBe(true);
    expect(parseResponse(fake.writes.join("")).body).toBe(body);
  });
});
