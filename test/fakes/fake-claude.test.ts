import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { readRecord } from "./record";

const FAKE_PATH = resolve(import.meta.dir, "fake-claude.ts");
const FLAGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
type Block = { type: string; text: string; id: string; name: string; input: { command: string; file_path: string; content: string }; tool_use_id: string; content: string; is_error: boolean };
type Event = {
  type: string; subtype: string; session_id: string; uuid: string; cwd: string; model: string;
  permissionMode: string; tools: string[]; mcp_servers: unknown[]; apiKeySource: string;
  claude_code_version: string; capabilities: unknown[]; parent_tool_use_id: null;
  message: { id: string; content: Block[] }; error: string; is_error: boolean;
  num_turns: number; duration_ms: number; total_cost_usd: number; result?: string;
  usage: { input_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; output_tokens: number };
  permission_denials: { tool_name: string; tool_use_id: string; tool_input: { command: string; file_path: string; content: string } }[];
  rate_limit_info: { status: string; resetsAt: number; rate_limit_type: string };
};
function start(args = FLAGS, scenario: Record<string, unknown> = {}, extra: Record<string, string> = {}) {
  const cwd = mkdtempSync(join(process.env.HOME!, "fake-claude-"));
  const config = join(cwd, "config");
  mkdirSync(config);
  const scenarioFile = join(cwd, "scenario.json");
  writeFileSync(scenarioFile, JSON.stringify({ version: 1, turns: [], ...scenario }));
  // The system can take many seconds to write a core dump after a SIGSEGV crash step, so the fake
  // runs with core dumps turned off. exec keeps the process ID, so the test still holds the fake.
  const child = Bun.spawn(["sh", "-c", 'ulimit -c 0; exec "$@"', "sh", FAKE_PATH, ...args], {
    cwd, env: { ...process.env, CLAUDE_CONFIG_DIR: config, RELAY_FAKE_SCENARIO: scenarioFile, TZ: "UTC", ...extra },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const lines: string[] = [];
  let output = "";
  let ended = false;
  let outputEnded = false;
  void child.exited.then(() => { ended = true; });
  const stderr = new Response(child.stderr).text();
  const read = (async () => {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let partial = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const text = decoder.decode(chunk.value, { stream: true });
        output += text;
        partial += text;
        let newline: number;
        while ((newline = partial.indexOf("\n")) !== -1) {
          lines.push(partial.slice(0, newline));
          partial = partial.slice(newline + 1);
        }
      }
      const tail = decoder.decode();
      output += tail;
    } finally { outputEnded = true; reader.releaseLock(); }
  })();
  async function waitForLine(predicate: (line: string) => boolean, timeoutMs = 1800) {
    const deadline = performance.now() + timeoutMs;
    while (true) {
      const line = lines.find(predicate);
      if (line !== undefined) return line;
      if (outputEnded || performance.now() >= deadline) throw new Error(`No matching output line. Output: ${output}`);
      await pause(10);
    }
  }
  async function sendRaw(line: string) {
    child.stdin.write(line);
    await child.stdin.flush();
  }
  async function send(text = "work") {
    const line = JSON.stringify({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
    await sendRaw(line + "\n");
    return line;
  }
  const closeInput = () => { child.stdin.end(); };
  async function finish() {
    const code = await child.exited;
    await read;
    return { code, stdout: output, stderr: await stderr, lines, events: () => lines.map((line) => JSON.parse(line) as Event) };
  }
  async function cleanup() {
    if (!ended) child.kill("SIGKILL");
    await child.exited;
    await read;
    await stderr;
  }
  return { child, cwd, config, lines, waitForLine, send, sendRaw, closeInput, finish, cleanup, alive: () => !ended };
}
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const steps = (...items: Record<string, unknown>[]) => ({ turns: [{ steps: items }] });
const hasType = (type: string) => (line: string) => (JSON.parse(line) as Event).type === type;
async function run(args: string[], scenario: Record<string, unknown> = {}, extra: Record<string, string> = {}, message?: string) {
  const fake = start(args, scenario, extra);
  try {
    if (message !== undefined) await fake.send(message);
    fake.closeInput();
    return { ...(await fake.finish()), cwd: fake.cwd, config: fake.config };
  } finally { await fake.cleanup(); }
}
async function session(scenario: Record<string, unknown>) { return run(FLAGS, scenario, {}, "work"); }

test("--version uses the executable shebang and prints the pinned version", async () => {
  const result = await run(["--version"]);
  expect(result.stdout).toBe("2.1.282 (Claude Code)\n");
  expect(result.code).toBe(0);
  expect((await run(["--version"], { tool_version: "2.1.100" })).stdout).toBe("2.1.100 (Claude Code)\n");
}, 4000);

test("auth status reports the scenario and selected config directory", async () => {
  for (const [auth, code, loggedIn, method] of [
    [undefined, 0, true, "claude.ai"],
    [{ signed_in: false }, 1, false, "none"],
    [{ signed_in: true, method: "console" }, 0, true, "console"],
  ] as const) {
    const result = await run(["auth", "status", "--json"], auth === undefined ? {} : { auth });
    expect(result.code).toBe(code);
    expect(JSON.parse(result.stdout)).toMatchObject({ loggedIn, authMethod: method, configDirectory: result.config });
  }
}, 4000);

test("auth login succeeds by default and can fail", async () => {
  const success = await run(["auth", "login"]);
  expect(success.code).toBe(0);
  expect(success.stdout).toBe("Login successful.\n");
  const failure = await run(["auth", "login"], { login: { succeed: false } });
  expect(failure.code).toBe(1);
  expect(failure.stderr).toBe("Login failed.\n");
}, 4000);

test("stream JSON requires verbose", async () => {
  const result = await run(FLAGS.slice(0, -1));
  expect(result.code).toBe(1);
  expect(result.stderr).toBe("Error: When using --print, --output-format=stream-json requires --verbose\n");
}, 4000);

test("unknown options and invalid session IDs are rejected", async () => {
  const unknown = await run([...FLAGS, "--dangerously-skip-permissions"]);
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toBe("error: unknown option '--dangerously-skip-permissions'\n");
  const invalid = await run([...FLAGS, "--session-id", "abc"]);
  expect(invalid.code).toBe(1);
  expect(invalid.stderr).toBe("Error: Invalid session ID. Must be a valid UUID.\n");
}, 4000);

test("the default headless turn emits init, assistant and result with the documented fields", async () => {
  const id = randomUUID();
  const result = await run([...FLAGS, "--session-id", id, "--permission-mode", "acceptEdits", "--permission-prompts", "none", "--append-system-prompt", "x"], {}, {}, "work");
  expect(result.code).toBe(0);
  const events = result.events();
  expect(events).toHaveLength(3);
  expect(events[0]).toMatchObject({ type: "system", subtype: "init", session_id: id, cwd: realpathSync(result.cwd), model: "claude-sonnet-4-6", permissionMode: "acceptEdits", tools: ["Bash", "Edit", "Glob", "Grep", "Read", "Write"], mcp_servers: [], apiKeySource: "none", claude_code_version: "2.1.282", capabilities: [] });
  expect(events[1]!.message.content as unknown[]).toEqual([{ type: "text", text: "I finished the task." }]);
  expect(events[2]).toMatchObject({ type: "result", subtype: "success", is_error: false, session_id: id, num_turns: 1, duration_ms: 1000, total_cost_usd: 0.01, usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 200, output_tokens: 50 }, permission_denials: [] });
  for (const event of events) {
    expect(event.session_id).toBe(id);
    expect(event.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(event).not.toHaveProperty("jsonrpc");
  }
}, 4000);

test("run and write steps emit matching tool uses and results", async () => {
  const result = await session(steps({ say: "working" }, { run: "echo hello" }, { run: "false", exit_code: 2 }, { write: "src/a.ts", content: "export const a = 1;\n" }));
  const events = result.events();
  const uses = events.filter((event) => event.type === "assistant" && event.message.content[0]!.type === "tool_use").map((event) => event.message.content[0]!);
  const replies = events.filter((event) => event.type === "user").map((event) => event.message.content[0]!);
  expect(uses).toHaveLength(3);
  expect(uses[0]).toMatchObject({ id: "toolu_fake_0001", name: "Bash", input: { command: "echo hello" } });
  expect(uses[1]).toMatchObject({ name: "Bash", input: { command: "false" } });
  expect(uses[2]).toMatchObject({ name: "Write", input: { file_path: join(realpathSync(result.cwd), "src/a.ts"), content: "export const a = 1;\n" } });
  for (let i = 0; i < uses.length; i++) expect(replies[i]!.tool_use_id).toBe(uses[i]!.id);
  expect(replies[0]).toMatchObject({ is_error: false, content: "" });
  expect(replies[1]).toMatchObject({ is_error: true, content: "Exit code 2" });
  expect(replies[2]).toMatchObject({ is_error: false, content: `File created successfully at: ${join(realpathSync(result.cwd), "src/a.ts")}` });
  expect(readFileSync(join(result.cwd, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
  expect(events.at(-1)!.num_turns).toBe(4);
}, 4000);

test("usage limits report exact five-hour and weekly reset texts", async () => {
  for (const [window, name, text] of [
    ["primary", "five_hour", "You've hit your session limit · resets 3:45pm"],
    ["seven_day", "seven_day", "You've hit your weekly limit · resets Wed 3:45pm"],
  ] as const) {
    const result = await session(steps({ limit: { window, resets_at: "2026-10-07T15:45:00Z" } }, { say: "late" }));
    const events = result.events();
    expect(events.find((event) => event.type === "rate_limit_event")!.rate_limit_info).toMatchObject({ status: "rejected", resetsAt: 1791387900, rate_limit_type: name });
    expect(events.find((event) => event.type === "assistant")).toMatchObject({ error: "rate_limit", message: { content: [{ type: "text", text }] } });
    expect(events.at(-1)).toMatchObject({ subtype: "success", is_error: true, result: text, total_cost_usd: 0, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } });
    expect(result.code).toBe(1);
  }
}, 4000);

test("rate limits emit an API error without a usage event", async () => {
  const result = await session(steps({ limit: { window: "primary", resets_at: "2026-10-07T15:45:00Z", kind: "rate" } }));
  expect(result.events().some((event) => event.type === "rate_limit_event")).toBe(false);
  expect(result.events().find((event) => event.type === "assistant")).toMatchObject({ error: "rate_limit", message: { content: [{ text: "API Error: Rate limit reached" }] } });
  expect(result.code).toBe(1);
}, 4000);

test("each API error retains its error field and fails the turn", async () => {
  for (const [error, text] of [
    ["authentication_failed", "Invalid API key · Please run /login"],
    ["overloaded", "API Error: Repeated 529 Overloaded errors"],
    ["billing_error", "Credit balance is too low"],
    ["server_error", "API Error: 500 Internal server error"],
  ]) {
    const result = await session(steps({ error }));
    expect(result.events().find((event) => event.type === "assistant")).toMatchObject({ error, message: { content: [{ text }] } });
    expect(result.events().at(-1)!.is_error).toBe(true);
    expect(result.code).toBe(1);
  }
}, 4000);

test("approval denials are included in a successful result", async () => {
  const result = await session(steps({ approval: { command: "rm -rf build" } }));
  const events = result.events();
  const denial = events.at(-1)!.permission_denials[0]!;
  expect(events.at(-1)!.permission_denials).toHaveLength(1);
  expect(denial).toMatchObject({ tool_name: "Bash", tool_input: { command: "rm -rf build" } });
  expect(denial.tool_use_id).toBe(events[1]!.message.content[0]!.id);
  expect(events[2]!.message.content[0]).toMatchObject({ is_error: true, content: "Claude requested permissions to use Bash, but you haven't granted it yet." });
  expect(result.code).toBe(0);
}, 4000);

test("crashes retain the last flushed assistant line and the terminating signal", async () => {
  for (const signal of ["SIGKILL", "SIGSEGV"] as const) {
    const fake = start(FLAGS, steps({ say: "before crash" }, { crash: { signal } }));
    try {
      await fake.send();
      fake.closeInput();
      const result = await fake.finish();
      expect(fake.child.signalCode).toBe(signal);
      expect(result.events().at(-1)).toMatchObject({ type: "assistant", message: { content: [{ text: "before crash" }] } });
      expect(result.events().some((event) => event.type === "result")).toBe(false);
    } finally { await fake.cleanup(); }
  }
}, 10_000);

// Core dumps allowed on purpose: the fake must still end at once, because it is not dumpable.
test.if(process.platform === "linux")("a SIGSEGV crash ends at once even when core dumps are allowed", async () => {
  const cwd = mkdtempSync(join(process.env.HOME!, "fake-claude-"));
  const scenarioFile = join(cwd, "scenario.json");
  writeFileSync(scenarioFile, JSON.stringify({ version: 1, ...steps({ crash: { signal: "SIGSEGV" } }) }));
  const child = Bun.spawn(["sh", "-c", 'ulimit -c unlimited 2>/dev/null; exec "$@"', "sh", FAKE_PATH, ...FLAGS], {
    cwd, env: { ...process.env, CLAUDE_CONFIG_DIR: cwd, RELAY_FAKE_SCENARIO: scenarioFile },
    stdin: "pipe", stdout: "ignore", stderr: "ignore",
  });
  child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: "go" }, parent_tool_use_id: null }) + "\n");
  child.stdin.end();
  const started = performance.now();
  await child.exited;
  expect(child.signalCode).toBe("SIGSEGV");
  expect(performance.now() - started).toBeLessThan(3000);
}, 10_000);

test("exit ends immediately without a result", async () => {
  const result = await session(steps({ exit: 3 }));
  expect(result.code).toBe(3);
  expect(result.events().some((event) => event.type === "result")).toBe(false);
}, 4000);

test("stderr and raw steps preserve the supplied text", async () => {
  const result = await session(steps({ stderr: "diagnostic" }, { raw: "{not json" }));
  expect(result.stderr).toBe("diagnostic\n");
  expect(result.lines).toContain("{not json");
  expect(result.stdout).toContain("\n{not json\n");
}, 4000);

test("finish prevents later steps", async () => {
  const result = await session(steps({ say: "early" }, { finish: true }, { say: "late" }));
  expect(result.stdout).not.toContain("late");
  expect(result.events().at(-1)).toMatchObject({ is_error: false, result: "early" });
}, 4000);

test("startup delay precedes the first line", async () => {
  const started = performance.now();
  const fake = start(FLAGS, { startup_delay_ms: 300 });
  try {
    await fake.send();
    await fake.waitForLine(hasType("system"));
    expect(performance.now() - started).toBeGreaterThanOrEqual(300);
    fake.closeInput();
    expect((await fake.finish()).code).toBe(0);
  } finally { await fake.cleanup(); }
}, 4000);

test("SIGINT interrupts a hanging turn and leaves the process ready for input", async () => {
  const fake = start(FLAGS, steps({ hang: true }, { say: "late" }));
  try {
    await fake.send();
    await fake.waitForLine(hasType("system"));
    fake.child.kill("SIGINT");
    const line = await fake.waitForLine(hasType("result"));
    expect(JSON.parse(line)).toMatchObject({ subtype: "error_during_execution", is_error: true });
    expect(JSON.parse(line)).not.toHaveProperty("result");
    expect(fake.lines.map((item) => JSON.parse(item) as Event).find((event) => event.type === "user")!.message.content as unknown[]).toEqual([{ type: "text", text: "[Request interrupted by user]" }]);
    await pause(300);
    expect(fake.alive()).toBe(true);
    fake.closeInput();
    expect((await fake.finish()).code).toBe(1);
  } finally { await fake.cleanup(); }
}, 4000);

test("SIGTERM during a hang exits 143 without a result", async () => {
  const fake = start(FLAGS, steps({ hang: true }));
  try {
    await fake.send();
    await fake.waitForLine(hasType("system"));
    fake.child.kill("SIGTERM");
    const result = await fake.finish();
    expect(result.code).toBe(143);
    expect(result.events().some((event) => event.type === "result")).toBe(false);
  } finally { await fake.cleanup(); }
}, 4000);

test("ignore_sigterm persists until SIGKILL", async () => {
  const fake = start(FLAGS, steps({ ignore_sigterm: true }, { say: "ready" }, { hang: true }));
  try {
    await fake.send();
    await fake.waitForLine((line) => line.includes('"text":"ready"'));
    fake.child.kill("SIGTERM");
    await pause(300);
    expect(fake.alive()).toBe(true);
    fake.child.kill("SIGKILL");
    await fake.finish();
    expect(fake.child.signalCode).toBe("SIGKILL");
  } finally { await fake.cleanup(); }
}, 4000);

test("messages received during a turn wait in order and init appears once", async () => {
  const fake = start(FLAGS, { turns: [{ steps: [{ run: "first", delay_ms: 300 }, { say: "first done" }] }, { steps: [{ say: "second done" }] }] });
  try {
    await fake.send("first");
    await fake.waitForLine((line) => line.includes('"command":"first"'));
    await fake.send("second");
    fake.closeInput();
    const result = await fake.finish();
    const events = result.events();
    const results = events.filter((event) => event.type === "result");
    expect(results.map((event) => event.result)).toEqual(["first done", "second done"]);
    expect(events.filter((event) => event.type === "system")).toHaveLength(1);
    expect(events.findIndex((event) => event.type === "assistant" && event.message.content[0]!.text === "second done")).toBeGreaterThan(events.findIndex((event) => event.type === "result"));
  } finally { await fake.cleanup(); }
}, 4000);

test("resume supplies the session ID and a scenario ID overrides the requested ID", async () => {
  const id = randomUUID();
  const resumed = await run([...FLAGS, "--resume", id], {}, {}, "work");
  expect(resumed.events()[0]!.session_id).toBe(id);
  const override = randomUUID();
  const result = await run([...FLAGS, "--session-id", id], { session_id: override }, {}, "work");
  expect(result.events().every((event) => event.session_id === override)).toBe(true);
}, 4000);

test("records retain arguments and input while excluding credential values", async () => {
  const dir = mkdtempSync(join(process.env.HOME!, "claude-record-"));
  const recordFile = join(dir, "record.json");
  const value = "fake-" + crypto.randomUUID();
  const args = [...FLAGS, "--model", "test-model"];
  const fake = start(args, {}, { RELAY_FAKE_RECORD: recordFile, SOME_TOKEN: value });
  try {
    const first = await fake.send("one");
    const second = await fake.send("two");
    fake.closeInput();
    await fake.finish();
    const record = readRecord(recordFile);
    expect(record.argv).toEqual(args);
    expect(record.stdin).toBe("pipe");
    expect(record.input).toEqual([first, second]);
    expect(record.env_names).toContain("SOME_TOKEN");
    expect(readFileSync(recordFile, "utf8")).not.toContain(value);
    expect(record.env.CLAUDE_CONFIG_DIR).toBe(fake.config);
  } finally { await fake.cleanup(); }
}, 4000);

test("invalid scenarios identify the turn and step and exit 2", async () => {
  const result = await run(FLAGS, steps({ say: "valid" }, { say: 5 }));
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("Turn 1, step 2");
  expect(result.stdout).toBe("");
}, 4000);

test("malformed headless input exits 1", async () => {
  const fake = start();
  try {
    await fake.sendRaw("{oops\n");
    fake.closeInput();
    const result = await fake.finish();
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("Error: fake-claude could not read the input line.\n");
  } finally { await fake.cleanup(); }
}, 4000);
