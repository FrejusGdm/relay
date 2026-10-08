// Interactive relay run: the agent has the terminal, Ctrl+C reaches only the agent, hook events
// are recorded for the worker, and the terminal is restored (task 9.6).
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAIN } from "../helpers/cli";
import { fakeEnv } from "../helpers/fake-programs";
import { relayBin } from "../helpers/relay-bin";
import { jobEvents, resetTime, runFixture, spawnRelayRun, steps, until, workers, type FakeScenario, type RunFixture } from "./helpers";

// relay's hooks in the fake Claude profile, as relay hooks install writes them.
function installHooks(fixture: RunFixture): void {
  const bin = relayBin();
  const profile = join(fixture.relayHome, "profiles", "claude-work");
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const hooks = Object.fromEntries(["SessionStart", "Stop", "StopFailure", "Notification", "SessionEnd"].map((event) => [event,
    [{ hooks: [{ type: "command", command: `'${bin}' hook claude ${event}`, timeout: 5 }] }]]));
  writeFileSync(join(profile, "settings.json"), JSON.stringify({ hooks }));
}

test("Ctrl+C in the terminal reaches only the agent; relay records the worker when the agent exits", async () => {
  const fixture = await runFixture();
  try {
    installHooks(fixture);
    const scenario: FakeScenario = { turns: [{ steps: [{ say: "Working." }, { hang: true }] }, { steps: [{ say: "Done." }] }] };
    const run = spawnRelayRun(fixture, ["claude:work"], scenario);
    run.child.stdin!.write("Start.\n");
    await until(() => run.stdout().includes("Working."));
    process.kill(-run.child.pid!, "SIGINT");
    await until(() => run.stdout().includes("Interrupted."));
    expect(run.child.exitCode).toBeNull();
    run.child.stdin!.write("Finish.\n");
    await until(() => run.stdout().includes("Done."));
    run.child.stdin!.end();
    expect(await run.exited).toBe(0);
    const [record] = workers(fixture);
    // add-relay-switch: after the agent exits, relay saves a checkpoint of kind auto.
    expect(run.stdout()).toMatch(new RegExp(`Recorded worker ${record!.worker_id} \\(claude:work\\)\\.\\nClaude Code · work stopped \\(exit code 0\\)\\nNo changes since checkpoint [0-9a-f]{6}\\n$`));
    expect(record).toMatchObject({ mode: "interactive", transport: "claude-interactive", permission: null, log_path: null, exit_code: 0, end_reason: "exited" });
    // add-relay-switch: a new job's agent gets the start prompt.
    expect(record!.argv).toEqual(["--session-id", record!.provider_session_id!, "--append-system-prompt", "<instructions>", "--", "<prompt>"]);
    const types = jobEvents(fixture).map((event) => event.type);
    // The interrupted turn fires no hook; the finished ones fire Stop. add-relay-switch: the start
    // prompt is the first turn, so the two lines typed run two more turns.
    expect(types.slice(types.indexOf("worker_started"))).toEqual([
      "worker_started", "worker_session_identified", "turn_completed", "availability", "turn_completed", "worker_ended",
    ]);
  } finally {
    fixture.cleanup();
  }
}, 30_000);

test("an interactive run exits 23 when the last turn stopped at a limit", async () => {
  const fixture = await runFixture();
  try {
    installHooks(fixture);
    const resets = resetTime();
    const run = spawnRelayRun(fixture, ["claude:work", "--prompt", "Go."], steps({ say: "Working." }, { limit: { window: "five_hour", resets_at: resets.toISOString() } }));
    await until(() => run.stdout().includes("You've hit your session limit"));
    await Bun.sleep(1500);
    run.child.stdin!.end();
    expect(await run.exited).toBe(23);
    expect(run.stderr()).toBe("Claude Code stopped: rate limit.\n");
    expect(workers(fixture)[0]!.argv.slice(-2)).toEqual(["--", "<prompt>"]);
    expect(jobEvents(fixture).find((event) => event.type === "turn_failed")?.data).toMatchObject({ reason: "rate_limit", source: "hook" });
  } finally {
    fixture.cleanup();
  }
}, 30_000);

test("after the agent exits, relay restores the terminal before it prints", async () => {
  const fixture = await runFixture();
  try {
    let output = "";
    const child = Bun.spawn([process.execPath, "--no-env-file", MAIN, "run", "claude:work"], {
      cwd: fixture.scratch.repo,
      env: { ...process.env, RELAY_HOME: fixture.relayHome, ...fakeEnv(steps({ say: "Hello." })) },
      terminal: { cols: 100, rows: 30, data: (_terminal, data) => { output += new TextDecoder().decode(data); } },
    });
    await until(() => output.includes("Claude Code 2.1.282 (fake)"));
    child.terminal!.write("Hi.\n");
    await until(() => output.includes("Hello."));
    child.terminal!.write("\x04");
    expect(await child.exited).toBe(0);
    await until(() => output.includes("Recorded worker"));
    child.terminal!.close();
    const restore = output.indexOf("\x1b[?1049l\x1b[?25h\x1b[0m");
    expect(restore).toBeGreaterThan(output.indexOf("Hello."));
    expect(restore).toBeLessThan(output.indexOf("Recorded worker"));
  } finally {
    fixture.cleanup();
  }
}, 30_000);

test("a one-word task such as update reaches an interactive agent as its prompt, not as a subcommand", async () => {
  for (const account of ["claude:work", "codex:personal"]) {
    const fixture = await runFixture(`[accounts."${account}"]\n`);
    try {
      const record = join(fixture.scratch.root, "record.json");
      const run = spawnRelayRun(fixture, [account, "--prompt", "update"], steps({ say: "Updated." }), { RELAY_FAKE_RECORD: record });
      await until(() => run.stdout().includes("Updated."));
      run.child.stdin!.end();
      expect(await run.exited).toBe(0);
      const argv = (JSON.parse(readFileSync(record, "utf8")) as { argv: string[] }).argv;
      expect(argv.at(-2)).toBe("--");
      // add-relay-switch: the task comes at the end of the start prompt.
      expect(argv.at(-1)!).toEndWith("\n\nYour request: update");
      expect(workers(fixture)[0]!.argv.slice(-2)).toEqual(["--", "<prompt>"]);
    } finally {
      fixture.cleanup();
    }
  }
}, 30_000);
