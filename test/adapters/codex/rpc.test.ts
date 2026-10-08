import { expect, test } from "bun:test";
import { RpcClient, RpcError, RpcTimeout } from "../../../src/adapters/codex/rpc";

function client() {
  const lines: string[] = [];
  const rpc = new RpcClient(async (line) => { lines.push(line); });
  return { rpc, lines };
}

test("requests use increasing IDs and answers match out of order", async () => {
  const { rpc, lines } = client();
  try {
    const first = rpc.request("thread/start", { cwd: "/project" });
    const second = rpc.request("account/rateLimits/read");
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { id: 1, method: "thread/start", params: { cwd: "/project" } },
      { id: 2, method: "account/rateLimits/read" },
    ]);
    rpc.receive({ id: 2, result: "second" });
    rpc.receive({ id: 99, result: "unknown" });
    rpc.receive({ id: 1, result: "first" });
    expect(await second).toBe("second");
    expect(await first).toBe("first");
    const third = rpc.request("turn/start");
    expect(JSON.parse(lines[2]!).id).toBe(3);
    rpc.receive({ id: 3, result: null });
    expect(await third).toBeNull();
  } finally { rpc.close(); }
});

test("error answers preserve the code, message and request method", async () => {
  const { rpc } = client();
  try {
    const request = rpc.request("thread/start");
    const rejected = request.catch((error: unknown) => error);
    rpc.receive({ id: 1, error: { code: -32601, message: "Method not found" } });
    const error = await rejected;
    expect(error).toBeInstanceOf(RpcError);
    if (!(error instanceof RpcError)) throw new Error("Expected RpcError.");
    expect(error.code).toBe(-32601);
    expect(error.message).toBe("Method not found");
    expect(error.method).toBe("thread/start");
  } finally { rpc.close(); }
});

test("a request times out and a late answer is ignored", async () => {
  const { rpc } = client();
  try {
    const error: unknown = await rpc.request("initialize", undefined, { timeoutMs: 5 }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(RpcTimeout);
    if (!(error instanceof RpcTimeout)) throw new Error("Expected RpcTimeout.");
    expect(error.method).toBe("initialize");
    rpc.receive({ id: 1, result: {} });
  } finally { rpc.close(); }
});

test("server requests and notifications reach listeners without an automatic answer", async () => {
  const { rpc, lines } = client();
  const requests: unknown[] = [];
  const notifications: unknown[] = [];
  const removeRequest = rpc.onServerRequest((message) => { requests.push(message); });
  const removeNotification = rpc.onNotification((message) => { notifications.push(message); });
  try {
    const pending = rpc.request("turn/start");
    const approval = { id: 1, method: "item/commandExecution/requestApproval", params: { command: "command" } };
    rpc.receive(approval);
    rpc.receive({ id: "server-id", method: "item/fileChange/requestApproval" });
    rpc.receive({ method: "turn/started", params: { turnId: "turn-1" } });
    expect(requests).toEqual([approval, { id: "server-id", method: "item/fileChange/requestApproval" }]);
    expect(notifications).toEqual([{ method: "turn/started", params: { turnId: "turn-1" } }]);
    expect(lines).toHaveLength(1);
    rpc.receive({ id: 1, result: "client answer" });
    expect(await pending).toBe("client answer");
    removeRequest(); removeNotification();
    rpc.receive(approval); rpc.receive({ method: "turn/started" });
    expect(requests).toHaveLength(2); expect(notifications).toHaveLength(1);
  } finally { rpc.close(); }
});

test("notifications have no ID and no sent message has a jsonrpc field", async () => {
  const { rpc, lines } = client();
  try {
    await rpc.notify("initialized");
    await rpc.notify("example", { value: 1 });
    const pending = rpc.request("initialize");
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { method: "initialized" }, { method: "example", params: { value: 1 } }, { id: 1, method: "initialize" },
    ]);
    for (const line of lines) { expect(line.endsWith("\n")).toBe(true); expect(JSON.parse(line)).not.toHaveProperty("jsonrpc"); }
    rpc.receive({ id: 1, result: {} }); await pending;
  } finally { rpc.close(); }
});

test("close rejects every pending request and is idempotent", async () => {
  const { rpc } = client();
  const first = rpc.request("initialize").catch((error: unknown) => error);
  const second = rpc.request("thread/start").catch((error: unknown) => error);
  rpc.close(); rpc.close();
  expect(await first).toEqual(new Error("The Codex app server closed before it answered initialize."));
  expect(await second).toEqual(new Error("The Codex app server closed before it answered thread/start."));
  await expect(rpc.request("turn/start")).rejects.toThrow("The Codex app server closed before it answered turn/start.");
});

test("write failures reject requests and notifications", async () => {
  const rpc = new RpcClient(async () => { throw new Error("Input closed."); });
  try {
    await expect(rpc.request("initialize")).rejects.toThrow("Input closed.");
    await expect(rpc.notify("initialized")).rejects.toThrow("Input closed.");
  } finally { rpc.close(); }
});

test("malformed messages leave a request pending until a valid answer", async () => {
  const { rpc } = client();
  try {
    const pending = rpc.request("initialize");
    for (const message of [null, [], 5, { id: 1 }, { id: 1, error: null }, { id: 1, method: 5, result: {} }]) rpc.receive(message);
    rpc.receive({ id: 1, result: "valid" });
    expect(await pending).toBe("valid");
  } finally { rpc.close(); }
});
