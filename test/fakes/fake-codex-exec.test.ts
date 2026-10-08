import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRecord } from "./record";
import type { Scenario } from "./scenario";

const FAKE_PATH = join(import.meta.dir, "fake-codex.ts");
const SESSION_ID = "0199a3c2-7d4e-7b10-9c1a-2f5e8d6b4a31";
type Message = Record<string, unknown>;
function folder() { return mkdtempSync(join(process.env.HOME!, "codex-exec-")); }
function running(args: string[], extra: Partial<Scenario> = {}, options: { cwd?: string; env?: Record<string, string>; stdin?: "ignore" | "pipe" } = {}) {
  const cwd = options.cwd ?? folder();
  const scenario = join(cwd, "scenario.json");
  writeFileSync(scenario, JSON.stringify({ version: 1, turns: [], ...extra }));
  const child = Bun.spawn([FAKE_PATH, ...args], {
    cwd, env: { ...process.env, ...options.env, RELAY_FAKE_SCENARIO: scenario },
    stdin: options.stdin ?? "ignore", stdout: "pipe", stderr: "pipe",
  });
  let text = "";
  let readError: unknown;
  const listeners = new Set<() => void>();
  const stdout = (async () => {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        text += done ? decoder.decode() : decoder.decode(value, { stream: true });
        for (const listener of listeners) listener();
        if (done) break;
      }
      return text;
    } catch (error) {
      readError = error;
      for (const listener of listeners) listener();
      throw error;
    } finally { reader.releaseLock(); }
  })();
  const stderr = new Response(child.stderr).text();
  return {
    child, cwd, stdout, stderr,
    waitForText(expected: string, timeoutMs = 1500): Promise<void> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error(`No output containing ${expected} arrived.`)), timeoutMs);
        function finish(error?: unknown) {
          clearTimeout(timer);
          listeners.delete(check);
          if (error !== undefined) reject(error);
          else resolve();
        }
        function check() {
          if (readError !== undefined) finish(readError);
          else if (text.includes(expected)) finish();
        }
        listeners.add(check);
        check();
      });
    },
    async dispose() {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      await Promise.all([stdout, stderr]);
    },
  };
}
async function run(args: string[], extra: Partial<Scenario> = {}, options: { cwd?: string; env?: Record<string, string> } = {}) {
  const fake = running(args, extra, options);
  try {
    const [stdout, stderr, code] = await Promise.all([fake.stdout, fake.stderr, fake.child.exited]);
    return { stdout, stderr, code, signal: fake.child.signalCode };
  } finally { await fake.dispose(); }
}
function jsonLines(text: string): Message[] { return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Message); }
function quote(text: string) { return "'" + text.replaceAll("'", "'\\''") + "'"; }
function hooks(cwd: string) {
  const log = join(cwd, "hook-input.jsonl");
  const command = `cat >> ${quote(log)}; printf '\\n' >> ${quote(log)}`;
  writeFileSync(join(cwd, "hooks.json"), JSON.stringify({ hooks: Object.fromEntries(["SessionStart", "Stop", "SessionEnd"].map((event) => [event, [{ hooks: [{ type: "command", command, timeout: 1 }] }]])) }));
  return log;
}
function logLines(log: string): Message[] {
  if (!existsSync(log)) return [];
  // A hook writes its JSON before its final newline, so only read complete records.
  const text = readFileSync(log, "utf8");
  return text.split("\n").slice(0, -1).filter(Boolean).map((line) => JSON.parse(line) as Message);
}
async function waitForLog(log: string, count: number) {
  const deadline = performance.now() + 1500;
  while (logLines(log).length < count) {
    if (performance.now() >= deadline) throw new Error("The expected hook input did not arrive.");
    await new Promise<void>((done) => setTimeout(done, 10));
  }
  return logLines(log);
}

test("exec uses its argument prompt, records EOF input and writes under -C", async () => {
  const cwd = folder();
  const root = join(cwd, "worktree");
  mkdirSync(root);
  const record = join(cwd, "record.json");
  const credential = "fake-" + crypto.randomUUID();
  const args = ["exec", "--json", "-C", root, "-s", "workspace-write", "-c", 'developer_instructions="\\"x\\""', "do it"];
  const content = "export const a = 1;\n";
  const result = await run(args, { turns: [{ steps: [{ say: "Done." }, { run: "bun test", exit_code: 0 }, { write: "src/a.ts", content }] }] }, { cwd, env: { RELAY_FAKE_RECORD: record, SOME_TOKEN: credential } });
  expect(result.code).toBe(0);
  const received = readRecord(record);
  expect(received.stdin).toBe("eof");
  expect(received.input).toEqual([]);
  expect(received.argv).toEqual(args);
  expect(received.cwd).toBe(cwd);
  expect(readFileSync(record, "utf8")).not.toContain(credential);
  const lines = jsonLines(result.stdout);
  expect(lines.map((line) => line.type)).toEqual(["thread.started", "turn.started", "item.completed", "item.started", "item.completed", "item.completed", "turn.completed"]);
  expect(lines[0]?.thread_id).toEqual(expect.any(String));
  expect(lines[2]).toMatchObject({ item: { id: "item_0", type: "agent_message", text: "Done." } });
  expect(lines[3]).toMatchObject({ item: { id: "item_1", type: "command_execution", command: "bun test", aggregated_output: "", exit_code: null, status: "in_progress" } });
  expect(lines[4]).toMatchObject({ item: { id: "item_1", type: "command_execution", command: "bun test", exit_code: 0, status: "completed" } });
  expect(lines[5]).toMatchObject({ item: { id: "item_2", type: "file_change", changes: [{ path: "src/a.ts", kind: "add" }], status: "completed" } });
  expect(lines[6]).toEqual({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50, reasoning_output_tokens: 0 } });
  expect(readFileSync(join(root, "src/a.ts"), "utf8")).toBe(content);
  expect(existsSync(join(cwd, "src/a.ts"))).toBe(false);
  expect(lines.every((line) => !("jsonrpc" in line))).toBe(true);
}, 4000);

test("exec prints the exact Plus-plan usage-limit text in local time", async () => {
  const result = await run(["exec", "--json", "x"], { turns: [{ steps: [{ limit: { window: "primary", resets_at: "2027-01-05T15:45:00Z" } }] }] }, { env: { TZ: "UTC" } });
  const message = "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Jan 5th, 2027 3:45 PM.";
  const lines = jsonLines(result.stdout);
  expect(lines[2]).toEqual({ type: "error", message });
  expect(lines[3]).toEqual({ type: "turn.failed", error: { message } });
  expect(result.stdout).toContain("You\u2019ve hit your usage limit");
  expect(result.code).toBe(1);
}, 4000);

test("exec resume preserves the ID and arguments and rejects -C", async () => {
  const cwd = folder();
  const record = join(cwd, "record.json");
  const args = ["exec", "resume", SESSION_ID, "--json", "-c", 'sandbox_mode="workspace-write"', "-c", 'developer_instructions="x"', "Continue."];
  const result = await run(args, {}, { cwd, env: { RELAY_FAKE_RECORD: record } });
  expect(result.code).toBe(0);
  expect(jsonLines(result.stdout)[0]).toEqual({ type: "thread.started", thread_id: SESSION_ID });
  expect(readRecord(record).argv).toEqual(args);
  const rejected = await run(["exec", "resume", SESSION_ID, "-C", "/tmp", "--json", "x"]);
  expect(rejected.code).toBe(2);
  expect(rejected.stderr).toBe("error: unexpected argument '-C' found\n");
}, 4000);

test("exec rejects removed flags and requires --json", async () => {
  const removed = await run(["exec", "--full-auto", "x"]);
  expect(removed.code).toBe(2);
  expect(removed.stderr).toBe("error: unexpected argument '--full-auto' found\n");
  const text = await run(["exec", "x"]);
  expect(text.code).toBe(2);
  expect(text.stderr).toBe("fake-codex: exec supports only --json output.\n");
}, 4000);

test("SIGINT aborts a hung exec turn without a completion line", async () => {
  const fake = running(["exec", "--json", "x"], { turns: [{ steps: [{ hang: true }, { say: "Too late." }] }] });
  try {
    await fake.waitForText('"type":"turn.started"');
    fake.child.kill("SIGINT");
    expect(await fake.child.exited).toBe(1);
    const lines = jsonLines(await fake.stdout);
    expect(lines.map((line) => line.type)).toEqual(["thread.started", "turn.started"]);
  } finally { await fake.dispose(); }
}, 4000);

test("an error step fails the exec turn and exits 1", async () => {
  const result = await run(["exec", "--json", "x"], { turns: [{ steps: [{ error: "authentication_failed" }] }] });
  expect(result.code).toBe(1);
  expect(jsonLines(result.stdout).at(-1)).toEqual({ type: "turn.failed", error: { message: "unexpected status 401 Unauthorized" } });
}, 4000);

test("exec declines command approval and continues to successful completion", async () => {
  const result = await run(["exec", "--json", "x"], { turns: [{ steps: [{ approval: { command: "rm -rf build" } }] }] });
  const lines = jsonLines(result.stdout);
  expect(lines[2]).toMatchObject({ type: "item.completed", item: { type: "command_execution", command: "rm -rf build", exit_code: null, status: "declined" } });
  expect(lines[3]?.type).toBe("turn.completed");
  expect(result.code).toBe(0);
}, 4000);

test("a crash preserves the signal and does not emit completion", async () => {
  const result = await run(["exec", "--json", "x"], { turns: [{ steps: [{ say: "Before the crash." }, { crash: { signal: "SIGKILL" } }, { say: "Too late." }] }] });
  expect(result.signal).toBe("SIGKILL");
  expect(jsonLines(result.stdout).at(-1)).toMatchObject({ item: { text: "Before the crash." } });
  expect(result.stdout).not.toContain("turn.completed");
}, 4000);

test("exec with EOF and no prompt reports that no prompt was provided", async () => {
  const result = await run(["exec", "--json"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toBe("No prompt provided.\n");
  expect(result.stdout).toBe("");
}, 4000);

for (const hooksTrusted of [true, false, "modified"] as const) {
  const trusted = hooksTrusted === true;
  test(`interactive sessions ${trusted ? "run" : "do not run"} ${hooksTrusted === "modified" ? "modified" : "installed"} hooks`, async () => {
    const cwd = folder();
    const root = join(cwd, "worktree");
    mkdirSync(root);
    const log = hooks(cwd);
    const record = join(cwd, "record.json");
    const fake = running(["-C", root, "-c", 'developer_instructions="x"', "first prompt"], {
      session_id: SESSION_ID, hooks_trusted: hooksTrusted,
      turns: [{ steps: [{ say: "First turn finished." }] }, { steps: [{ say: "Second turn finished." }] }],
    }, { cwd, stdin: "pipe", env: { CODEX_HOME: cwd, RELAY_FAKE_RECORD: record } });
    try {
      await fake.waitForText("First turn finished.\n");
      if (trusted) {
        const input = await waitForLog(log, 2);
        expect(input[0]).toMatchObject({ session_id: SESSION_ID, hook_event_name: "SessionStart", cwd: root, model: "gpt-6.1-sol", turn_id: null, source: "startup", transcript_path: join(cwd, "sessions", "fake", `rollout-${SESSION_ID}.jsonl`) });
        expect(input[1]).toMatchObject({ hook_event_name: "Stop", turn_id: "turn_1" });
      } else expect(existsSync(log)).toBe(false);
      fake.child.stdin!.write("second prompt\n");
      fake.child.stdin!.flush();
      await fake.waitForText("Second turn finished.\n");
      if (trusted) expect((await waitForLog(log, 3))[2]).toMatchObject({ hook_event_name: "Stop", turn_id: "turn_2" });
      fake.child.stdin!.end();
      expect(await fake.child.exited).toBe(0);
      expect(await fake.stdout).toContain(`Codex 0.160.0 (fake), session ${SESSION_ID}\n`);
      expect(readRecord(record).input).toEqual(["second prompt"]);
      if (trusted) expect(logLines(log)[3]).toMatchObject({ hook_event_name: "SessionEnd", session_id: SESSION_ID });
      else expect(existsSync(log)).toBe(false);
    } finally { await fake.dispose(); }
  }, 4000);
}

test("interactive resume runs SessionStart with the resume source", async () => {
  const cwd = folder();
  const root = join(cwd, "worktree");
  mkdirSync(root);
  const log = hooks(cwd);
  const fake = running(["resume", SESSION_ID, "-C", root], { hooks_trusted: true }, { cwd, stdin: "pipe", env: { CODEX_HOME: cwd } });
  try {
    await fake.waitForText(`session ${SESSION_ID}\n`);
    expect((await waitForLog(log, 1))[0]).toMatchObject({ session_id: SESSION_ID, hook_event_name: "SessionStart", source: "resume", cwd: root, turn_id: null });
    fake.child.stdin!.end();
    expect(await fake.child.exited).toBe(0);
    expect(logLines(log)[1]).toMatchObject({ hook_event_name: "SessionEnd" });
  } finally { await fake.dispose(); }
}, 4000);
