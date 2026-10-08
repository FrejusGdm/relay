// Headless relay run: progress output, --json, exit codes and Ctrl+C (task 9.5).
import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clockText } from "../../src/run/progress";
import { jobEvents, relayRun, resetTime, runFixture, spawnRelayRun, steps, until, workers } from "./helpers";

const SESSION = "7c1e9a52-0b7e-4c1e-9f0a-3d5b2a1c4e8f";

test("text progress: the session, each command and changed file, and the end of the turn", async () => {
  const fixture = await runFixture();
  try {
    const result = await relayRun(fixture, ["claude:work", "--headless", "--prompt", "Fix the test."], {
      session_id: SESSION, turns: [{ steps: [{ say: "Fixing." }, { run: "bun test", exit_code: 0 }, { write: "src/a.ts", content: "x\n" }] }],
    });
    expect(result).toEqual({
      code: 0, stderr: "",
      stdout: "Allowed claude:work on this project.\nStarted Claude Code on claude:work · session 7c1e9a52\n  ran bun test · exit 0\n  changed src/a.ts\nTurn finished · 1 s\n",
    });
  } finally {
    fixture.cleanup();
  }
});

test("--json prints each worker event as one JSON line, messages included", async () => {
  const fixture = await runFixture();
  try {
    const result = await relayRun(fixture, ["claude:work", "--headless", "--json", "--prompt", "Fix it."], {
      session_id: SESSION, turns: [{ steps: [{ say: "Fixing." }, { run: "bun test" }] }],
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("Allowed claude:work on this project.\n");
    const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    const id = workers(fixture)[0]!.worker_id;
    expect(lines.every((line) => line.worker_id === id)).toBe(true);
    expect(lines.map((line) => line.kind)).toEqual(["session_started", "message", "tool", "tool", "turn_completed", "exited"]);
    expect(lines[1]).toEqual({ worker_id: id, kind: "message", text: "Fixing.", partial: false });
  } finally {
    fixture.cleanup();
  }
});

test("exit 23 at a Codex usage limit, with the reset time", async () => {
  const fixture = await runFixture('[accounts."codex:personal"]\n');
  try {
    const resets = resetTime(2);
    const result = await relayRun(fixture, ["codex:personal", "--headless", "--prompt", "Go on."],
      steps({ say: "Working." }, { limit: { window: "primary", resets_at: resets.toISOString() } }));
    expect(result.code).toBe(23);
    expect(result.stderr).toBe(`Codex stopped: usage limit, resets ${clockText(resets)}.\n`);
    expect(workers(fixture)[0]).toMatchObject({ end_reason: "exited", transport: "codex-app-server" });
  } finally {
    fixture.cleanup();
  }
});

test("exit 24 when the agent fails, crashes or asks for a permission", async () => {
  const fixture = await runFixture();
  try {
    const failed = await relayRun(fixture, ["claude:work", "--headless", "--prompt", "Go."], steps({ error: "overloaded" }));
    const log = workers(fixture)[0]!.log_path;
    expect(failed).toMatchObject({ code: 24, stderr: `Claude Code stopped: the service is overloaded. Details are in ${log}.\n` });

    const crashed = await relayRun(fixture, ["claude:work", "--headless", "--prompt", "Go."], steps({ say: "Oh." }, { crash: { signal: "SIGKILL" } }));
    expect(crashed).toMatchObject({ code: 24, stderr: `Claude Code stopped unexpectedly. Details are in ${workers(fixture)[0]!.log_path}.\n` });
    expect(workers(fixture)[0]).toMatchObject({ signal: "SIGKILL", end_reason: "exited" });

    const denied = await relayRun(fixture, ["claude:work", "--headless", "--prompt", "Go."], steps({ approval: { command: "rm -rf build" } }));
    expect(denied.code).toBe(24);
    expect(denied.stderr).toBe("Claude Code was not allowed to use Bash. relay does not answer permission requests; run relay run claude:work in your terminal to answer it yourself.\n");
  } finally {
    fixture.cleanup();
  }
});

test("a Codex approval request stops the agent, because relay never answers it", async () => {
  const fixture = await runFixture('[accounts."codex:personal"]\n');
  try {
    const result = await relayRun(fixture, ["codex:personal", "--headless", "--prompt", "Clean up."], steps({ approval: { command: "rm -rf build" } }));
    expect(result.code).toBe(24);
    expect(result.stderr).toBe("Codex asked for permission to run rm -rf build. relay does not answer permission requests; run relay run codex:personal in your terminal to answer it yourself.\n");
    expect(workers(fixture)[0]).toMatchObject({ end_reason: "relay_stopped" });
    expect(jobEvents(fixture).find((event) => event.type === "approval_requested")?.data.summary).toBe("run rm -rf build");
    expect(jobEvents(fixture).at(-1)?.data).toMatchObject({ end_reason: "relay_stopped", stop_how: "clean" });
  } finally {
    fixture.cleanup();
  }
});

test("Ctrl+C interrupts the turn, prints the resume hint and exits 130", async () => {
  const fixture = await runFixture();
  try {
    const run = spawnRelayRun(fixture, ["claude:work", "--headless", "--prompt", "Wait."], { session_id: SESSION, ...steps({ say: "Waiting." }, { hang: true }) });
    await until(() => run.stdout().includes("Started Claude Code"));
    process.kill(-run.child.pid!, "SIGINT");
    expect(await run.exited).toBe(130);
    expect(run.stderr()).toBe(`Interrupted. Resume with relay run claude:work --resume ${SESSION}\n`);
    expect(jobEvents(fixture).at(-1)).toMatchObject({ type: "worker_ended", data: { end_reason: "interrupted", stop_how: "clean" } });
    expect(jobEvents(fixture).some((event) => event.type === "turn_failed" && event.data.reason === "interrupted")).toBe(true);
    expect(workers(fixture)[0]).toMatchObject({ end_reason: "interrupted" });
  } finally {
    fixture.cleanup();
  }
});

// A Claude Code stand-in that ignores SIGINT, SIGTERM and the end of its input, so only SIGKILL
// ends it. The adapter's own escalation sends SIGKILL 15 seconds after an interrupt.
function stubbornClaude(root: string): string {
  const path = join(root, "stubborn-claude");
  writeFileSync(path, `#!${process.execPath}
const argv = process.argv.slice(2);
if (argv.includes("--version")) { console.log("2.1.282 (Claude Code)"); process.exit(0); }
if (argv[0] === "auth") { console.log("{}"); process.exit(0); }
const session = argv[argv.indexOf("--session-id") + 1];
process.on("SIGINT", () => {});
process.on("SIGTERM", () => {});
process.stdin.once("data", () => console.log(JSON.stringify({ type: "system", subtype: "init", session_id: session, model: "m" })));
setInterval(() => {}, 60000);
`, { mode: 0o755 });
  return path;
}

test("a second Ctrl+C stops the agent at once", async () => {
  const fixture = await runFixture();
  try {
    const run = spawnRelayRun(fixture, ["claude:work", "--headless", "--prompt", "Wait."], {}, { RELAY_CLAUDE_BIN: stubbornClaude(fixture.scratch.root) });
    await until(() => run.stdout().includes("Started Claude Code"));
    process.kill(-run.child.pid!, "SIGINT");
    await Bun.sleep(300);
    const before = Date.now();
    process.kill(-run.child.pid!, "SIGINT");
    expect(await run.exited).toBe(130);
    expect(Date.now() - before).toBeLessThan(5000);
    expect(jobEvents(fixture).at(-1)).toMatchObject({ type: "worker_ended", data: { end_reason: "interrupted", stop_how: "killed", signal: "SIGKILL" } });
  } finally {
    fixture.cleanup();
  }
});

test("a second Ctrl+C while relay is already stopping the agent stops it at once", async () => {
  const fixture = await runFixture();
  try {
    const run = spawnRelayRun(fixture, ["claude:work", "--headless", "--prompt", "Wait."], {}, { RELAY_CLAUDE_BIN: stubbornClaude(fixture.scratch.root) });
    await until(() => run.stdout().includes("Started Claude Code"));
    process.kill(-run.child.pid!, "SIGINT");
    // After 10 seconds without the end of the turn, relay is stopping the agent with its 30-second limit.
    await Bun.sleep(11_000);
    expect(run.child.exitCode).toBeNull();
    const before = Date.now();
    process.kill(-run.child.pid!, "SIGINT");
    expect(await run.exited).toBe(130);
    expect(Date.now() - before).toBeLessThan(2000);
    expect(jobEvents(fixture).at(-1)).toMatchObject({ data: { end_reason: "interrupted", stop_how: "killed", signal: "SIGKILL" } });
  } finally {
    fixture.cleanup();
  }
}, 30_000);

test("a second SIGTERM while relay is stopping the agent stops it at once", async () => {
  const fixture = await runFixture();
  try {
    const run = spawnRelayRun(fixture, ["claude:work", "--headless", "--prompt", "Wait."], {}, { RELAY_CLAUDE_BIN: stubbornClaude(fixture.scratch.root) });
    await until(() => run.stdout().includes("Started Claude Code"));
    run.child.kill("SIGTERM");
    await Bun.sleep(500);
    const before = Date.now();
    run.child.kill("SIGTERM");
    expect(await run.exited).toBe(143);
    expect(Date.now() - before).toBeLessThan(2000);
    expect(jobEvents(fixture).at(-1)).toMatchObject({ data: { end_reason: "relay_stopped", stop_how: "killed", signal: "SIGKILL" } });
  } finally {
    fixture.cleanup();
  }
}, 30_000);

for (const signal of ["SIGTERM", "SIGHUP"] as const) {
  test(`${signal} to relay stops the agent, records the worker and exits 143`, async () => {
    const fixture = await runFixture();
    try {
      const run = spawnRelayRun(fixture, ["claude:work", "--headless", "--prompt", "Wait."], steps({ say: "Waiting." }, { hang: true }));
      await until(() => run.stdout().includes("Started Claude Code"));
      run.child.kill(signal);
      expect(await run.exited).toBe(143);
      expect(jobEvents(fixture).at(-1)).toMatchObject({ type: "worker_ended", data: { end_reason: "relay_stopped", stop_how: "clean" } });
      expect(workers(fixture)[0]).toMatchObject({ end_reason: "relay_stopped" });
      expect(existsSync(join(fixture.relayHome, "locks", `${fixture.jobId}.worker.lock`))).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });
}
