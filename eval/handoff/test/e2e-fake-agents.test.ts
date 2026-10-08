// The smoke plan against the real relay binary named by RELAY_BIN and relay's fake agents
// (add-handoff-evaluation task 8.1). The test is skipped when RELAY_BIN is not set, because
// `bun test` alone builds no relay binary. Nothing here starts a real provider: relay starts
// test/fakes/fake-claude.ts and test/fakes/fake-codex.ts instead of claude and codex.
import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunResult } from "../src/result.ts";
import { cleanup, relayRepo, REPO, temp } from "./helpers.ts";

afterEach(cleanup);

const RELAY_BIN = process.env.RELAY_BIN;
const FAKES = join(REPO, "test", "fakes");
const SOLUTION = join(REPO, "eval", "handoff", "tasks", "rate-limiter", "solution", "src");
const RUNS = ["rate-limiter__baseline__claude__r1", "rate-limiter__handoff__claude-to-codex__steps-50__r1"];

async function run(command: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = Bun.spawn(command, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { exitCode, output: stdout + stderr };
}

// Runs the harness in a pseudo-terminal and types `yes` when the confirmation appears.
async function terminalRun(root: string, args: string[], env: NodeJS.ProcessEnv) {
  let output = "";
  const decoder = new TextDecoder();
  const proc = Bun.spawn([process.execPath, "run", join(root, "eval", "handoff", "src", "main.ts"), ...args], {
    cwd: root, env,
    terminal: { cols: 160, rows: 40, data(_term, data) { output += decoder.decode(data, { stream: true }); } },
  });
  try {
    const deadline = Date.now() + 30_000;
    while (!output.includes("Type yes to start:")) {
      if (proc.exitCode !== null || Date.now() >= deadline) throw new Error(`The confirmation prompt did not appear: ${output}`);
      await Bun.sleep(20);
    }
    proc.terminal!.write("yes\r");
    const exitCode = await proc.exited;
    await Bun.sleep(20);
    output += decoder.decode();
    return { exitCode, output: output.replaceAll("\r\n", "\n") };
  } finally {
    if (proc.exitCode === null) { proc.kill(); await proc.exited; }
    proc.terminal!.close();
  }
}

test.skipIf(!RELAY_BIN)("The smoke plan runs against the real relay with fake agents", async () => {
  const root = await relayRepo(["rate-limiter"]);
  const home = temp("eval-home");
  const relayHome = temp("relay-home");
  writeFileSync(join(home, "targets.toml"), 'claude = "claude:personal"\ncodex = "codex:personal"\n');

  // Claude Code fixes the bucket, runs the tests, then fixes the limiter. Each command takes
  // 5 seconds, so the harness can switch at step 3 of 6 before Claude Code finishes.
  const bucket = readFileSync(join(SOLUTION, "bucket.ts"), "utf8");
  const limiter = readFileSync(join(SOLUTION, "limiter.ts"), "utf8");
  const scenario = join(temp("scenario"), "scenario.json");
  writeFileSync(scenario, JSON.stringify({
    claude: { version: 1, turns: [{ steps: [
      { say: "I will fix the refill first." },
      { write: "src/bucket.ts", content: bucket },
      { run: "bun test", delay_ms: 5000 },
      { write: "src/limiter.ts", content: limiter },
      { run: "bun test", delay_ms: 5000 },
      { run: "bun test ./test", delay_ms: 5000 },
      { run: "git diff", delay_ms: 5000 },
      { say: "Both classes are done and the tests pass." },
    ] }] },
    codex: { version: 1, turns: [{ steps: [
      { say: "Reading .relay/checkpoint.md and checking the claims." },
      { run: "bun test", exit_code: 0 },
      { write: "src/limiter.ts", content: limiter },
      { write: ".relay/verify.md", content: "| Claim | Holds | Evidence |\n|---|---|---|\n| Refill is exact | yes | bun test passes |\n" },
      { finish: true },
    ] }] },
  }));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RELAY_EVAL_HOME: home, RELAY_BIN: resolve(RELAY_BIN!), RELAY_HOME: relayHome,
    RELAY_CLAUDE_BIN: join(FAKES, "fake-claude.ts"), RELAY_CODEX_BIN: join(FAKES, "fake-codex.ts"),
    RELAY_KEEP_FAKE_ENV: "1", RELAY_FAKE_SCENARIO: scenario,
    RELAY_GITLEAKS: join(REPO, "test", "helpers", "fake-gitleaks.ts"),
  };
  delete env.CI;

  // The two accounts, added with relay's own command. The fakes report them as signed in.
  for (const [provider, name] of [["claude", "personal"], ["codex", "personal"]]) {
    const added = await run([env.RELAY_BIN!, "account", "add", provider!, name!, "--yes"], home, env);
    expect(added.output).toContain(`Added ${provider}:${name}.`);
    expect(added.exitCode).toBe(0);
  }
  // relay would ask the outgoing fake for handoff notes by resuming its session, and the fake
  // would play its scenario again. relay builds the notes from the event log instead.
  appendFileSync(join(relayHome, "config.toml"), "\n[handoff]\nask_for_summary = false\n");
  // Both accounts are allowed on the two scratch projects in advance. When relay switch --yes adds
  // a new account to the allow list and then hands the switch to the relay run that holds the
  // agent, that relay run adds the account a second time and the switch stops with exit code 70.
  for (const id of RUNS) {
    const path = JSON.stringify(join(home, "work", id, "repo"));
    appendFileSync(join(relayHome, "config.toml"), `\n[[projects]]\npath = ${path}\nallow = ["claude:personal", "codex:personal"]\n`);
  }

  const first = await terminalRun(root, ["run", "smoke", "--campaign", "e2e"], env);
  expect(first.output).toContain("[1 of 2] rate-limiter, baseline on claude:personal, repetition 1\n");
  expect(first.output).toContain(`Saved result ${RUNS[0]}.\n`);
  expect(first.output).toContain("  Step 3 of about 6 on claude:personal. Switching.\n  Continuing on codex:personal.\n");
  expect(first.output).toContain(`Saved result ${RUNS[1]}.\n`);
  expect(first.exitCode).toBe(0);

  const campaign = join(home, "campaigns", "e2e");
  for (const id of RUNS) {
    const result = JSON.parse(readFileSync(join(campaign, "runs", id, "result.json"), "utf8")) as RunResult;
    expect({ id, status: result.status, notes: result.notes }).toEqual({ id, status: "completed", notes: "" });
    expect(result.safety).toEqual({ ok: true, violations: [], bypass_flags_seen: false, argv_recorded: true });
    expect(result.contamination).toBe(false);
    expect(result.outcome?.solved).toBe(true);
    expect(result.tools.relay).toBe(JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version);
  }
  const handoff = JSON.parse(readFileSync(join(campaign, "runs", RUNS[1]!, "result.json"), "utf8")) as RunResult;
  expect(handoff.segments.map((segment) => [segment.target, segment.end_reason]))
    .toEqual([["claude:personal", "stopped_by_switch"], ["codex:personal", "exited"]]);
  expect(handoff.handoff?.relay_exit_code).toBe(0);
  expect(handoff.handoff?.verify_written).toBe(true);
  expect(existsSync(join(campaign, "runs", RUNS[1]!, "handoff-prompt.md"))).toBe(true);
  expect(readdirSync(join(home, "work"))).toEqual([]);

  const summary = await run([process.execPath, "run", join(root, "eval", "handoff", "src", "main.ts"), "summarize", "e2e"], root, env);
  expect(summary.exitCode).toBe(0);
  expect(readFileSync(join(campaign, "summary.md"), "utf8")).toContain("# Handoff evaluation");
}, 240_000);
