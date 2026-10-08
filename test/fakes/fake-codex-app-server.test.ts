import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRecord } from "./record";
import type { Scenario, Step } from "./scenario";

const FAKE_PATH = join(import.meta.dir, "fake-codex.ts");
const SESSION_ID = "0199a3c2-7d4e-7b10-9c1a-2f5e8d6b4a31";
type Message = Record<string, unknown>;
function at(value: unknown, ...path: (string | number)[]): unknown {
  for (const key of path) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}
function folder() { return mkdtempSync(join(process.env.HOME!, "codex-server-")); }
function scenarioFile(cwd: string, extra: Partial<Scenario> = {}) {
  const file = join(cwd, "scenario.json");
  writeFileSync(file, JSON.stringify({ version: 1, turns: [], ...extra }));
  return file;
}
async function command(args: string[], extra: Partial<Scenario> = {}) {
  const cwd = folder();
  const child = Bun.spawn([FAKE_PATH, ...args], {
    cwd, env: { ...process.env, RELAY_FAKE_SCENARIO: scenarioFile(cwd, extra) },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  } finally { if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
}
function client(extra: Partial<Scenario> = {}, env: Record<string, string> = {}, cwd = folder()) {
  const child = Bun.spawn([FAKE_PATH, "app-server"], {
    cwd, env: { ...process.env, ...env, RELAY_FAKE_SCENARIO: scenarioFile(cwd, extra) },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const lines: Message[] = [];
  const listeners = new Set<() => void>();
  let readError: unknown;
  const output = (async () => {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let end: number;
        while ((end = pending.indexOf("\n")) !== -1) {
          lines.push(JSON.parse(pending.slice(0, end)) as Message);
          pending = pending.slice(end + 1);
          for (const listener of listeners) listener();
        }
        if (done) break;
      }
      if (pending !== "") throw new Error("The server left an incomplete output line.");
    } catch (error) { readError = error; for (const listener of listeners) listener(); }
    finally { reader.releaseLock(); }
  })();
  const stderr = new Response(child.stderr).text();
  let nextId = 1;
  function waitFor(predicate: (message: Message) => boolean, timeoutMs = 1500): Promise<Message> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(undefined, new Error("No matching server message arrived.")), timeoutMs);
      function finish(message?: Message, error?: unknown) {
        clearTimeout(timer);
        listeners.delete(check);
        if (error !== undefined) reject(error);
        else resolve(message!);
      }
      function check() {
        if (readError !== undefined) { finish(undefined, readError); return; }
        const message = lines.find(predicate);
        if (message !== undefined) finish(message);
      }
      listeners.add(check);
      check();
    });
  }
  function send(value: unknown) { child.stdin.write(JSON.stringify(value) + "\n"); child.stdin.flush(); }
  return {
    child, cwd, lines, stderr, waitFor,
    request(method: string, params: unknown = {}) {
      const id = nextId++;
      const response = waitFor((message) => message.id === id && ("result" in message || "error" in message));
      send({ id, method, params });
      return response;
    },
    notify(method: string, params: unknown = {}) { send({ method, params }); },
    respond(id: number, result: unknown) { send({ id, result }); },
    async close() {
      child.stdin.end();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([child.exited, new Promise<void>((done) => { timer = setTimeout(() => { child.kill("SIGKILL"); done(); }, 1000); })]);
        await child.exited;
        await output;
        await stderr;
      } finally { clearTimeout(timer); if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
    },
  };
}
type Client = ReturnType<typeof client>;
async function start(c: Client, cwd = c.cwd) {
  expect(await c.request("initialize")).toMatchObject({ result: { userAgent: "codex_cli_rs/0.160.0" } });
  c.notify("initialized");
  const response = await c.request("thread/start", { cwd });
  return at(response, "result", "thread", "id") as string;
}
async function turn(c: Client, threadId: string) {
  const response = await c.request("turn/start", { threadId, input: [{ type: "text", text: "Do it.", text_elements: [] }] });
  return at(response, "result", "turn", "id") as string;
}
const completed = (message: Message) => message.method === "turn/completed";
function quote(text: string) { return "'" + text.replaceAll("'", "'\\''") + "'"; }
function hooks(cwd: string, events: string[]) {
  const log = join(cwd, "hook-input.jsonl");
  const command = `cat >> ${quote(log)}; printf '\\n' >> ${quote(log)}`;
  writeFileSync(join(cwd, "hooks.json"), JSON.stringify({ hooks: Object.fromEntries(events.map((event) => [event, [{ hooks: [{ type: "command", command, timeout: 1 }] }]])) }));
  return { log, command };
}
function logLines(log: string): Message[] { return readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Message); }

test("version, login status and login follow the scenario", async () => {
  expect(await command(["--version"])).toMatchObject({ stdout: "codex-cli 0.160.0\n", code: 0 });
  expect(await command(["--version"], { tool_version: "0.161.0" })).toMatchObject({ stdout: "codex-cli 0.161.0\n", code: 0 });
  expect(await command(["login", "status"])).toMatchObject({ stdout: "Logged in using ChatGPT\n", code: 0 });
  expect(await command(["login", "status"], { auth: { signed_in: false } })).toMatchObject({ stdout: "Not logged in\n", code: 1 });
  const api = await command(["login", "status"], { auth: { signed_in: true, method: "API key" } });
  expect(api.code).toBe(0);
  expect(api.stdout).toContain("API key");
  expect(await command(["login"])).toMatchObject({ stdout: "Successfully logged in\n", code: 0 });
  expect(await command(["login"], { login: { succeed: false } })).toMatchObject({ stderr: "Error logging in\n", code: 1 });
}, 4000);

test("requests need initialization and a second initialize is refused", async () => {
  const c = client();
  try {
    expect(await c.request("thread/start")).toMatchObject({ error: { message: "Not initialized" } });
    await start(c);
    expect(await c.request("initialize")).toMatchObject({ error: { code: -32600, message: "Already initialized" } });
  } finally { await c.close(); }
}, 4000);

test("the record preserves the handshake order and parameters", async () => {
  const cwd = folder();
  const record = join(cwd, "record.json");
  const c = client({}, { RELAY_FAKE_RECORD: record }, cwd);
  const params = { clientInfo: { name: "relay", title: "relay", version: "0.1.0" }, capabilities: { experimentalApi: false, requestAttestation: false } };
  try {
    await c.request("initialize", params);
    c.notify("initialized");
    await c.request("thread/start");
    const input = readRecord(record).input;
    expect(JSON.parse(input[0]!)).toEqual({ id: 1, method: "initialize", params });
    expect(JSON.parse(input[1]!)).toEqual({ method: "initialized", params: {} });
  } finally { await c.close(); }
}, 4000);

test("thread start returns and announces the scenario session ID", async () => {
  const c = client({ session_id: SESSION_ID });
  try {
    expect(await start(c)).toBe(SESSION_ID);
    expect(await c.waitFor((m) => m.method === "thread/started")).toMatchObject({ params: { thread: { id: SESSION_ID, cwd: c.cwd, cliVersion: "0.160.0" } } });
  } finally { await c.close(); }
}, 4000);

test("a turn emits message, command, file and usage notifications in order", async () => {
  const content = "export const a = 1;\n";
  const c = client({ turns: [{ steps: [{ say: "Done." }, { run: "bun test", exit_code: 0 }, { write: "src/a.ts", content }] }] });
  const root = join(c.cwd, "worktree");
  mkdirSync(root);
  try {
    const id = await start(c, root);
    await turn(c, id);
    expect(await c.waitFor(completed)).toMatchObject({ params: { threadId: id, turn: { id: "turn_1", status: "completed", error: null } } });
    const events = c.lines.filter((m) => typeof m.method === "string" && m.method !== "thread/started");
    expect(events.map((m) => m.method)).toEqual(["turn/started", "item/started", "item/agentMessage/delta", "item/completed", "item/started", "item/completed", "item/started", "item/completed", "thread/tokenUsage/updated", "turn/completed"]);
    expect(events[1]).toMatchObject({ params: { item: { type: "agentMessage", id: "msg_1", text: "" } } });
    expect(events[2]).toMatchObject({ params: { itemId: "msg_1", delta: "Done." } });
    expect(events[3]).toMatchObject({ params: { item: { text: "Done." } } });
    expect(events[4]).toMatchObject({ params: { item: { id: "cmd_2", type: "commandExecution", command: "bun test", status: "inProgress" } } });
    expect(events[5]).toMatchObject({ params: { item: { command: "bun test", exitCode: 0, status: "completed" } } });
    expect(events[6]).toMatchObject({ params: { item: { type: "fileChange", changes: [{ path: "src/a.ts", kind: "add" }], status: "inProgress" } } });
    expect(events[7]).toMatchObject({ params: { item: { status: "completed" } } });
    expect(events[8]).toMatchObject({ params: { tokenUsage: { last: { totalTokens: 1250, inputTokens: 1000, cachedInputTokens: 200, outputTokens: 50, reasoningOutputTokens: 0 }, modelContextWindow: 272000 } } });
    expect(readFileSync(join(root, "src/a.ts"), "utf8")).toBe(content);
    expect(existsSync(join(c.cwd, "src/a.ts"))).toBe(false);
    expect(c.lines.every((line) => !("jsonrpc" in line))).toBe(true);
  } finally { await c.close(); }
}, 4000);

test("the Codex limit scenario updates the window before its failed completion", async () => {
  const c = client({ turns: [{ steps: [{ limit: { window: "primary", resets_at: "2026-10-07T15:45:00Z" } }] }] });
  try {
    await turn(c, await start(c));
    expect(await c.waitFor(completed)).toMatchObject({ params: { turn: { status: "failed", error: { codexErrorInfo: "usageLimitExceeded" } } } });
    expect(c.lines.findIndex((m) => m.method === "account/rateLimits/updated")).toBeLessThan(c.lines.findIndex(completed));
    expect(await c.request("account/rateLimits/read")).toMatchObject({ result: { rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1791387900 } }, ordinaryUsageAllowed: false } });
  } finally { await c.close(); }
}, 4000);

test("rate limits preserve a null usage answer and require authentication", async () => {
  const c = client({ rate_limits: { primary: { used_percent: 62, window_minutes: 300, resets_at: "2026-10-07T15:45:00Z" }, ordinary_usage_allowed: null, reached: null } });
  try {
    await c.request("initialize");
    expect(await c.request("account/rateLimits/read")).toMatchObject({ result: { ordinaryUsageAllowed: null, rateLimitsByLimitId: null, rateLimits: { primary: { usedPercent: 62, windowDurationMins: 300, resetsAt: 1791387900 }, secondary: null, rateLimitReachedType: null } } });
  } finally { await c.close(); }
  const signedOut = client({ auth: { signed_in: false } });
  try {
    await signedOut.request("initialize");
    expect(await signedOut.request("account/rateLimits/read")).toMatchObject({ error: { code: -32600, message: "codex account authentication required to read rate limits" } });
  } finally { await signedOut.close(); }
}, 4000);

const failures: [Step, string][] = [
  [{ error: "authentication_failed" }, "unauthorized"], [{ error: "overloaded" }, "serverOverloaded"],
  [{ error: "billing_error" }, "other"], [{ error: "server_error" }, "internalServerError"],
  [{ limit: { window: "primary", resets_at: "2026-10-07T15:45:00Z", kind: "rate" } }, "rateLimitExceeded"],
];
for (const [step, info] of failures) {
  test(`failure reports ${info}`, async () => {
    const c = client({ turns: [{ steps: [step] }] });
    try {
      await turn(c, await start(c));
      expect(await c.waitFor(completed)).toMatchObject({ params: { turn: { status: "failed", error: { codexErrorInfo: info } } } });
      expect(await c.waitFor((m) => m.method === "error")).toMatchObject({ params: { willRetry: false, error: { codexErrorInfo: info, additionalDetails: null } } });
      if (info === "rateLimitExceeded") expect(await c.request("account/rateLimits/read")).toMatchObject({ result: { rateLimits: { primary: null, secondary: null }, ordinaryUsageAllowed: true } });
    } finally { await c.close(); }
  }, 4000);
}

test("interrupt answers before completing the hung turn and is recorded", async () => {
  const cwd = folder();
  const record = join(cwd, "record.json");
  const c = client({ turns: [{ steps: [{ hang: true }, { say: "Too late." }] }] }, { RELAY_FAKE_RECORD: record }, cwd);
  try {
    const threadId = await start(c);
    const turnId = await turn(c, threadId);
    const response = await c.request("turn/interrupt", { threadId, turnId });
    expect(response.result).toEqual({});
    const ended = await c.waitFor(completed);
    expect(ended).toMatchObject({ params: { turn: { status: "interrupted", error: null } } });
    expect(c.lines.indexOf(response)).toBeLessThan(c.lines.indexOf(ended));
    expect(readRecord(record).input.map((line) => JSON.parse(line))).toContainEqual({ id: response.id, method: "turn/interrupt", params: { threadId, turnId } });
    expect(c.lines.some((m) => m.method === "item/agentMessage/delta")).toBe(false);
  } finally { await c.close(); }
}, 4000);

test("steering checks the active turn ID and refuses idle turns", async () => {
  const c = client({ turns: [{ steps: [{ hang: true }] }] });
  try {
    const threadId = await start(c);
    const turnId = await turn(c, threadId);
    expect(await c.request("turn/steer", { threadId, expectedTurnId: turnId, input: [] })).toMatchObject({ result: { turnId } });
    expect(await c.request("turn/steer", { threadId, expectedTurnId: "wrong" })).toMatchObject({ error: { message: `Expected turn wrong, but the active turn is ${turnId}.` } });
    expect(await c.request("turn/start", { threadId })).toMatchObject({ error: { message: "A turn is already running on this thread." } });
    await c.request("turn/interrupt", { threadId, turnId });
    await c.waitFor(completed);
    expect(await c.request("turn/steer", { expectedTurnId: turnId })).toMatchObject({ error: { message: "No active turn to steer." } });
  } finally { await c.close(); }
}, 4000);

test("command approval waits for a client answer and then declines the item", async () => {
  const c = client({ turns: [{ steps: [{ approval: { command: "rm -rf build" } }] }] });
  try {
    await turn(c, await start(c));
    const request = await c.waitFor((m) => m.method === "item/commandExecution/requestApproval");
    expect(request).toMatchObject({ id: 0, params: { command: "rm -rf build", cwd: c.cwd, itemId: "cmd_1" } });
    await expect(c.waitFor(completed, 300)).rejects.toThrow("No matching server message");
    c.respond(request.id as number, { decision: "decline" });
    expect(await c.waitFor((m) => m.method === "item/completed")).toMatchObject({ params: { item: { status: "declined", exitCode: null } } });
    expect(await c.waitFor(completed)).toMatchObject({ params: { turn: { status: "completed" } } });
  } finally { await c.close(); }
}, 4000);

for (const [trusted, status] of [[false, "untrusted"], [true, "trusted"], ["modified", "modified"]] as const) {
  test(`hooks/list reports ${status} command hooks`, async () => {
    const cwd = folder();
    const { command } = hooks(cwd, ["SessionStart", "Stop"]);
    const c = client({ hooks_trusted: trusted }, { CODEX_HOME: cwd }, cwd);
    try {
      await c.request("initialize");
      const response = await c.request("hooks/list", { cwds: [cwd] });
      expect(at(response, "result", "data", 0, "hooks")).toEqual([
        { eventName: "SessionStart", matcher: null, command, timeout: 1, sourcePath: join(cwd, "hooks.json"), trustStatus: status },
        { eventName: "Stop", matcher: null, command, timeout: 1, sourcePath: join(cwd, "hooks.json"), trustStatus: status },
      ]);
    } finally { await c.close(); }
  }, 4000);
}

test("an app server can stop immediately before reading input", async () => {
  const result = await command(["app-server"], { app_server: "exit_immediately" });
  expect(result).toEqual({ code: 2, stdout: "", stderr: "fake-codex: the app server stopped at start.\n" });
}, 4000);

test("a silent app server records requests and exits when input closes", async () => {
  const cwd = folder();
  const record = join(cwd, "record.json");
  const c = client({ app_server: "no_answer" }, { RELAY_FAKE_RECORD: record }, cwd);
  try {
    c.child.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: {} }) + "\n");
    c.child.stdin.flush();
    await expect(c.waitFor(() => true, 500)).rejects.toThrow("No matching server message");
    expect(readRecord(record).input).toHaveLength(1);
    await c.close();
    expect(c.child.exitCode).toBe(0);
    expect(c.lines).toEqual([]);
  } finally { if (c.child.exitCode === null) await c.close(); }
}, 4000);

test("method-not-found mode still answers initialization", async () => {
  const c = client({ app_server: "method_not_found" });
  try {
    expect(await c.request("initialize")).toMatchObject({ result: { userAgent: "codex_cli_rs/0.160.0" } });
    expect(await c.request("thread/start")).toMatchObject({ error: { code: -32601, message: "Method not found" } });
  } finally { await c.close(); }
}, 4000);

test("unknown methods receive a method-not-found response", async () => {
  const c = client();
  try {
    await c.request("initialize");
    expect(await c.request("unknown")).toMatchObject({ error: { code: -32601, message: "Method not found" } });
  } finally { await c.close(); }
}, 4000);

for (const trusted of [true, false]) {
  test(`app-server hooks ${trusted ? "run" : "stay inactive"} according to trust`, async () => {
    const cwd = folder();
    const { log } = hooks(cwd, ["SessionStart", "Stop", "SessionEnd"]);
    const c = client({ session_id: SESSION_ID, hooks_trusted: trusted }, { CODEX_HOME: cwd }, cwd);
    try {
      await turn(c, await start(c));
      await c.waitFor(completed);
      if (trusted) {
        expect(logLines(log)[0]).toMatchObject({ session_id: SESSION_ID, source: "startup", cwd, hook_event_name: "SessionStart", turn_id: null, model: "gpt-6.1-sol" });
        expect(logLines(log)[1]).toMatchObject({ hook_event_name: "Stop", turn_id: "turn_1" });
      } else expect(existsSync(log)).toBe(false);
      await c.close();
      if (trusted) expect(logLines(log)[2]).toMatchObject({ hook_event_name: "SessionEnd" });
      else expect(existsSync(log)).toBe(false);
    } finally { if (c.child.exitCode === null) await c.close(); }
  }, 4000);
}

test("thread resume uses the requested ID and requires it", async () => {
  const c = client();
  try {
    await c.request("initialize");
    expect(await c.request("thread/resume", {})).toMatchObject({ error: { code: -32602, message: "Invalid params: threadId is required" } });
    expect(await c.request("thread/resume", { threadId: SESSION_ID })).toMatchObject({ result: { thread: { id: SESSION_ID } } });
  } finally { await c.close(); }
}, 4000);

for (const hanging of [false, true]) {
  test(`closing input ends the server${hanging ? " during a hang" : " while idle"}`, async () => {
    const c = client({ turns: [{ steps: [{ hang: true }] }] });
    try {
      const threadId = await start(c);
      if (hanging) await turn(c, threadId);
      await c.close();
      expect(c.child.exitCode).toBe(0);
      expect(c.lines.some(completed)).toBe(false);
    } finally { if (c.child.exitCode === null) await c.close(); }
  }, 4000);
}
