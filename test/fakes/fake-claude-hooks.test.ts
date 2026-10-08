import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const FAKE_PATH = resolve(import.meta.dir, "fake-claude.ts");
const FLAGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
const EVENTS = ["SessionStart", "Stop", "StopFailure", "Notification", "SessionEnd"];
type HookInput = { session_id: string; transcript_path: string; cwd: string; permission_mode: string; hook_event_name: string; source?: string; reason?: string };
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
function fixture() {
  const cwd = mkdtempSync(join(process.env.HOME!, "claude-hooks-"));
  const config = join(cwd, "config");
  mkdirSync(config);
  const log = join(cwd, "hooks.log");
  const status = join(cwd, "status.json");
  const command = `cat >> ${quote(log)}; echo >> ${quote(log)}`;
  const group = (matcher?: string) => ({ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: "command", command }] });
  const hooks = Object.fromEntries(EVENTS.map((event) => [event, [group()]]));
  function readHooks(): HookInput[] {
    if (!existsSync(log)) return [];
    return readFileSync(log, "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as HookInput);
  }
  function start(scenario: Record<string, unknown> = {}, args = FLAGS, settings: Record<string, unknown> = { hooks }) {
    writeFileSync(join(config, "settings.json"), JSON.stringify(settings));
    const scenarioFile = join(cwd, "scenario.json");
    writeFileSync(scenarioFile, JSON.stringify({ version: 1, turns: [], ...scenario }));
    const child = Bun.spawn([FAKE_PATH, ...args], {
      cwd, env: { ...process.env, CLAUDE_CONFIG_DIR: config, RELAY_FAKE_SCENARIO: scenarioFile, TZ: "UTC" },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const lines: string[] = [];
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
          partial += decoder.decode(chunk.value, { stream: true });
          let newline: number;
          while ((newline = partial.indexOf("\n")) !== -1) {
            lines.push(partial.slice(0, newline));
            partial = partial.slice(newline + 1);
          }
        }
      } finally { outputEnded = true; reader.releaseLock(); }
    })();
    async function waitForLine(predicate: (line: string) => boolean, timeoutMs = 1800) {
      const deadline = performance.now() + timeoutMs;
      while (true) {
        const line = lines.find(predicate);
        if (line !== undefined) return line;
        if (outputEnded || performance.now() >= deadline) throw new Error(`No matching line. Output: ${lines.join("\n")}`);
        await pause(10);
      }
    }
    async function send(text: string, interactive = false) {
      child.stdin.write(interactive ? text + "\n" : JSON.stringify({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null }) + "\n");
      await child.stdin.flush();
    }
    const closeInput = () => { child.stdin.end(); };
    async function finish() {
      const code = await child.exited;
      await read;
      return { code, lines, stderr: await stderr };
    }
    async function cleanup() {
      if (!ended) child.kill("SIGKILL");
      await child.exited;
      await read;
      await stderr;
    }
    return { child, lines, waitForLine, send, closeInput, finish, cleanup, alive: () => !ended };
  }
  return { cwd, config, log, status, hooks, group, readHooks, start };
}
const steps = (...items: Record<string, unknown>[]) => ({ turns: [{ steps: items }] });

test("usage limits run SessionStart, StopFailure and SessionEnd in order", async () => {
  const f = fixture();
  const id = randomUUID();
  const fake = f.start(steps({ limit: { window: "primary", resets_at: "2026-10-07T15:45:00Z" } }), [...FLAGS, "--session-id", id]);
  try {
    await fake.send("work");
    fake.closeInput();
    expect((await fake.finish()).code).toBe(1);
    const log = f.readHooks();
    expect(log.map((input) => input.hook_event_name)).toEqual(["SessionStart", "StopFailure", "SessionEnd"]);
    expect(log[0]).toMatchObject({ source: "startup", session_id: id, model: "claude-sonnet-4-6" });
    expect(log[1]).toMatchObject({ hook_event_name: "StopFailure", error: "rate_limit", error_details: "429 Too Many Requests", last_assistant_message: "You've hit your session limit · resets 3:45pm" });
    expect(log[2]).toMatchObject({ reason: "other" });
    for (const input of log) {
      expect(input).toMatchObject({ session_id: id, cwd: realpathSync(f.cwd), permission_mode: "default" });
      expect(input.transcript_path).toBe(join(f.config, "projects", realpathSync(f.cwd).replace(/[^A-Za-z0-9]/g, "-"), id + ".jsonl"));
      expect(typeof input.hook_event_name).toBe("string");
      expect(existsSync(input.transcript_path)).toBe(false);
    }
  } finally { await fake.cleanup(); }
}, 4000);

test("success runs Stop with the last assistant message", async () => {
  const f = fixture();
  const fake = f.start(steps({ say: "earlier" }, { say: "done" }));
  try {
    await fake.send("work");
    fake.closeInput();
    expect((await fake.finish()).code).toBe(0);
    expect(f.readHooks().find((input) => input.hook_event_name === "Stop")).toMatchObject({ stop_hook_active: false, last_assistant_message: "done" });
  } finally { await fake.cleanup(); }
}, 4000);

test("notification steps invoke Notification with their message and type", async () => {
  const f = fixture();
  const fake = f.start(steps({ notification: "quota_auto_resume_fired" }));
  try {
    await fake.send("work");
    fake.closeInput();
    await fake.finish();
    expect(f.readHooks().find((input) => input.hook_event_name === "Notification")).toMatchObject({ notification_type: "quota_auto_resume_fired", message: "quota_auto_resume_fired" });
  } finally { await fake.cleanup(); }
}, 4000);

test("SessionStart matchers distinguish startup from resume", async () => {
  for (const resumed of [false, true]) {
    const f = fixture();
    const id = randomUUID();
    const fake = f.start({}, resumed ? [...FLAGS, "--resume", id] : FLAGS, { hooks: { SessionStart: [f.group("resume")] } });
    try {
      await fake.send("work");
      fake.closeInput();
      await fake.finish();
      const log = f.readHooks();
      expect(log).toHaveLength(resumed ? 1 : 0);
      if (resumed) expect(log[0]).toMatchObject({ source: "resume", session_id: id });
    } finally { await fake.cleanup(); }
  }
}, 4000);

test("a command hook timeout lets the turn finish within three seconds", async () => {
  const f = fixture();
  const started = performance.now();
  const fake = f.start({}, FLAGS, { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "sleep 5", timeout: 1 }] }] } });
  try {
    await fake.send("work");
    await fake.waitForLine((line) => (JSON.parse(line) as { type: string }).type === "result", 2800);
    expect(performance.now() - started).toBeLessThan(3000);
    fake.closeInput();
    expect((await fake.finish()).code).toBe(0);
  } finally { await fake.cleanup(); }
}, 4000);

test("interactive sessions run the status line and accept a second turn through a pipe", async () => {
  const f = fixture();
  const id = randomUUID();
  const fake = f.start(steps({ say: "hello" }, { status_line: { five_hour: 20, seven_day: 100, resets_at: "2026-10-07T15:45:00Z" } }), ["--session-id", id, "--append-system-prompt", "x", "first prompt"], { hooks: f.hooks, statusLine: { type: "command", command: `cat > ${quote(f.status)}` } });
  try {
    await fake.waitForLine((line) => line === "hello");
    // Stop runs after the status command, so its log entry proves status.json is complete.
    const deadline = performance.now() + 1800;
    while (!f.readHooks().some((input) => input.hook_event_name === "Stop")) {
      if (performance.now() >= deadline) throw new Error("The first interactive turn did not stop.");
      await pause(10);
    }
    expect(JSON.parse(readFileSync(f.status, "utf8"))).toMatchObject({ session_id: id, rate_limits: { five_hour: { used_percentage: 20, resets_at: 1791387900 }, seven_day: { used_percentage: 100, resets_at: 1791387900 } } });
    await fake.send("again", true);
    await fake.waitForLine((line) => line === "I finished the task.");
    fake.closeInput();
    const result = await fake.finish();
    expect(result.code).toBe(0);
    expect(result.lines).toContain(`Claude Code 2.1.282 (fake), session ${id}`);
    expect(f.readHooks().filter((input) => input.hook_event_name === "Stop")).toHaveLength(2);
    expect(f.readHooks().at(-1)).toMatchObject({ hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
  } finally { await fake.cleanup(); }
}, 4000);

test("headless sessions skip the status line", async () => {
  const f = fixture();
  const fake = f.start(steps({ status_line: { five_hour: 20, seven_day: 100, resets_at: "2026-10-07T15:45:00Z" } }), FLAGS, { hooks: f.hooks, statusLine: { type: "command", command: `cat > ${quote(f.status)}` } });
  try {
    await fake.send("work");
    fake.closeInput();
    expect((await fake.finish()).code).toBe(0);
    expect(existsSync(f.status)).toBe(false);
  } finally { await fake.cleanup(); }
}, 4000);

test("interactive SIGINT while idle is ignored and SIGTERM exits 143", async () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const f = fixture();
    const fake = f.start({}, []);
    try {
      await fake.waitForLine((line) => line.startsWith("Claude Code 2.1.282 (fake)"));
      fake.child.kill(signal);
      if (signal === "SIGINT") {
        await pause(300);
        expect(fake.alive()).toBe(true);
        fake.closeInput();
        expect((await fake.finish()).code).toBe(0);
        expect(f.readHooks().at(-1)).toMatchObject({ hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
      } else {
        expect((await fake.finish()).code).toBe(143);
        expect(f.readHooks().some((input) => input.hook_event_name === "SessionEnd")).toBe(false);
      }
    } finally { await fake.cleanup(); }
  }
}, 4000);
