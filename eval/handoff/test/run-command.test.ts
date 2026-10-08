import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunResult } from "../src/result.ts";
import { cleanup, relayRepo, STUB_RELAY, temp, writeScenario } from "./helpers.ts";

afterEach(cleanup);

// Runs a committed copy of the harness in a pseudo-terminal, against the stub relay and made-up
// accounts, and types `yes` when the confirmation appears.
async function terminalRun(root: string, args: string[], env: NodeJS.ProcessEnv, answer?: string) {
  let output = "";
  const decoder = new TextDecoder();
  const proc = Bun.spawn([process.execPath, "run", join(root, "eval", "handoff", "src", "main.ts"), ...args], {
    cwd: root, env,
    terminal: { cols: 160, rows: 40, data(_term, data) { output += decoder.decode(data, { stream: true }); } },
  });
  try {
    if (answer !== undefined) {
      const deadline = Date.now() + 20000;
      while (!output.includes("Type yes to start:")) {
        if (proc.exitCode !== null || Date.now() >= deadline) throw new Error(`The confirmation prompt did not appear: ${output}`);
        await Bun.sleep(20);
      }
      proc.terminal!.write(`${answer}\r`);
    }
    const exitCode = await proc.exited;
    await Bun.sleep(20);
    output += decoder.decode();
    return { exitCode, output: output.replaceAll("\r\n", "\n") };
  } finally {
    if (proc.exitCode === null) { proc.kill(); await proc.exited; }
    proc.terminal!.close();
  }
}

test("The smoke plan runs against the stub, and a second invocation skips both completed runs", async () => {
  const root = await relayRepo(["rate-limiter"]);
  const solution = join(root, "eval", "handoff", "tasks", "rate-limiter", "solution");
  const home = temp("eval-home");
  writeFileSync(join(home, "targets.toml"), 'claude = "claude:eval-test"\ncodex = "codex:eval-test"\n');
  const scenario = writeScenario({
    workers: {
      "claude:eval-test": {
        step_delay_ms: 1000,
        steps: [
          { copy: join(solution, "src", "bucket.ts"), to: "src/bucket.ts" }, { run: ["bun", "test"] },
          { copy: join(solution, "src", "limiter.ts"), to: "src/limiter.ts" }, { run: ["bun", "test"] },
        ],
        end: "exited",
      },
      "codex:eval-test": {
        step_delay_ms: 100,
        steps: [{ copy: solution, to: "." }, { run: ["bun", "test"] }, { verify: "| Claim | Holds | Evidence |\n|---|---|---|\n| Refill is exact | yes | tests pass |\n" }],
        end: "exited",
      },
    },
  });
  const env: NodeJS.ProcessEnv = { ...process.env, RELAY_EVAL_HOME: home, RELAY_BIN: STUB_RELAY, RELAY_STUB_SCENARIO: scenario };
  delete env.CI;

  const first = await terminalRun(root, ["run", "smoke", "--campaign", "test"], env, "yes");
  expect(first.output).toContain("[1 of 2] rate-limiter, baseline on claude:eval-test, repetition 1\n");
  expect(first.output).toContain("Saved result rate-limiter__baseline__claude__r1.\n");
  expect(first.output).toContain("[2 of 2] rate-limiter, handoff from claude:eval-test to codex:eval-test at 50% of steps, repetition 1\n"
    + "  Step 2 of about 4 on claude:eval-test. Switching.\n  Continuing on codex:eval-test.\n");
  expect(first.output).toContain("Saved result rate-limiter__handoff__claude-to-codex__steps-50__r1.\n");
  expect(first.exitCode).toBe(0);

  const runs = join(home, "campaigns", "test", "runs");
  const read = (id: string) => readFileSync(join(runs, id, "result.json"), "utf8");
  const baseline = read("rate-limiter__baseline__claude__r1");
  const handoff = read("rate-limiter__handoff__claude-to-codex__steps-50__r1");
  for (const text of [baseline, handoff]) {
    const result = JSON.parse(text) as RunResult;
    expect(result.status).toBe("completed");
    expect(result.outcome?.solved).toBe(true);
    expect(result.safety.ok).toBe(true);
  }
  expect((JSON.parse(handoff) as RunResult).handoff?.verify_written).toBe(true);
  expect(readdirSync(join(home, "work"))).toEqual([]);

  const second = await terminalRun(root, ["run", "smoke", "--campaign", "test"], env);
  expect(second.exitCode).toBe(0);
  expect(second.output).toBe("Nothing left to run in campaign test.\n");
  expect(read("rate-limiter__baseline__claude__r1")).toBe(baseline);
  expect(read("rate-limiter__handoff__claude-to-codex__steps-50__r1")).toBe(handoff);
  expect(existsSync(join(home, "campaigns", "test", "campaign.json"))).toBe(true);
}, 120000);
