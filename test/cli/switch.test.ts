// relay switch (task 6.1): the command line, the output lines, --no-start, --json, the exit codes
// and the help. With RELAY_DOC_SAMPLES=1 the tests print each command and its exact output, for
// docs/handoff.md.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RelayResult } from "../helpers/cli";
import { runRelayInProcess } from "../helpers/cli";
import { until, workers } from "../run/helpers";
import { relayIn, relayProcess, Scenarios, switchFixture, type SwitchFixture } from "../handoff/switch-helpers";

setDefaultTimeout(60_000);

let fixture: SwitchFixture;
afterEach(() => fixture?.cleanup());

function sample(args: string[], result: RelayResult): RelayResult {
  if (process.env.RELAY_DOC_SAMPLES === "1") {
    console.log(`SAMPLE $ relay ${args.join(" ")}\n${result.stdout}${result.stderr}(exit code ${result.code})\nEND`);
  }
  return result;
}

async function relay(args: string[], options: { env?: Record<string, string>; answers?: string[] } = {}): Promise<RelayResult> {
  return sample(args, await relayIn(fixture, args, options));
}

async function claudeWorked(): Promise<void> {
  fixture.scenarios.set({ claude: { turns: [{ steps: [{ write: "src/auth/callback.ts", content: "export function handleCallback() {}\n" }, { say: "Done." }] }] } });
  expect((await relayIn(fixture, ["run", "claude:work", "--headless", "--prompt", "Add the callback."])).code).toBe(0);
}

describe("Command line", () => {
  test("a provider with one account resolves to it", async () => {
    fixture = await switchFixture();
    await claudeWorked();
    const result = await relay(["switch", "codex", "--no-start", "--no-summary"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toEndWith('Ready for Codex · personal.\nRun "relay run codex:personal" to start it.\n');
  });

  test("a provider with two accounts and another provider's default: exit 2", async () => {
    fixture = await switchFixture({ accounts: '[defaults]\naccount = "claude:work"\n\n[accounts."claude:work"]\n\n[accounts."codex:personal"]\n\n[accounts."codex:work"]\n' });
    await claudeWorked();
    expect(await relay(["switch", "codex"])).toEqual({
      code: 2, stdout: "",
      stderr: "relay: You have two Codex accounts: codex:personal, codex:work. Name one, for example relay switch codex:personal.\n",
    });
  });

  test("an unknown account: exit 2", async () => {
    fixture = await switchFixture();
    await claudeWorked();
    expect(await relay(["switch", "codex:home"])).toEqual({
      code: 2, stdout: "", stderr: "relay: codex:home is not one of your accounts. Add it with relay account add codex home.\n",
    });
  });

  test("the account already working on the job: exit 2", async () => {
    fixture = await switchFixture();
    fixture.scenarios.set({ codex: Scenarios.fixture("codex-starts.json") });
    const run = relayProcess(fixture, ["run", "codex:personal"]);
    try {
      await until(() => workers(fixture).length === 1);
      expect(await relay(["switch", "codex:personal"])).toEqual({ code: 2, stdout: "", stderr: "relay: Codex · personal is already working on this job.\n" });
    } finally {
      process.kill(-run.child.pid!, "SIGTERM");
      await run.exited;
    }
  });

  test("no agent ever worked on the job: exit 3", async () => {
    fixture = await switchFixture();
    expect(await relay(["switch", "codex:personal"])).toEqual({
      code: 3, stdout: "", stderr: "relay: No agent has worked on this job yet. Start one with relay run codex:personal.\n",
    });
  });
});

describe("Output", () => {
  test("no agent running: the output starts with the checkpoint line", async () => {
    fixture = await switchFixture();
    await claudeWorked();
    fixture.scratch.write("src/auth/google.ts", "export const google = 1;\n");
    fixture.scenarios.set({ claude: Scenarios.fixture("claude-answers-notes.json") });
    const result = await relay(["switch", "codex:personal", "--no-start", "--check", "true"], { answers: [] });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^relay will run these checks at every handoff: true\nSaved checkpoint [0-9a-f]{6}\nAsking Claude Code for handoff notes\nRan true · passed\n(Found \d+ differences? between the notes and the repository\n)?Wrote \.relay\/checkpoint\.md\nReady for Codex · personal\.\nRun "relay run codex:personal" to start it\.\n$/);
  });

  test("nothing changed since the last checkpoint: relay uses it and saves no new one", async () => {
    fixture = await switchFixture();
    await claudeWorked();
    const refs = fixture.scratch.git("for-each-ref", "--format=%(refname)", `refs/relay/jobs/${fixture.jobId}/checkpoints/`);
    const result = await relay(["switch", "codex:personal", "--no-start", "--no-summary"]);
    expect(result.stdout).toMatch(/^Using checkpoint [0-9a-f]{6} \(no changes since it was saved\)\n/);
    expect(fixture.scratch.git("for-each-ref", "--format=%(refname)", `refs/relay/jobs/${fixture.jobId}/checkpoints/`)).toBe(refs);
  });

  test("an interactive start without a terminal: exit 7, nothing changed", async () => {
    fixture = await switchFixture();
    await claudeWorked();
    // The job's agents work in the terminal.
    writeFileSync(join(fixture.relayHome, "jobs", fixture.jobId, "handoff-settings.json"), JSON.stringify({
      schema_version: 1, job_id: fixture.jobId, mode: "interactive", permission: null, checks: [], next_handoff: 1,
    }), { mode: 0o600 });
    expect(await relay(["switch", "codex:personal"])).toEqual({
      code: 7, stdout: "", stderr: "relay: This switch needs a terminal. Run relay switch codex:personal in the project.\n",
    });
  });
});

describe("--json", () => {
  test("a prepared handoff prints one JSON object", async () => {
    fixture = await switchFixture({ allow: ["claude:work"] });
    await claudeWorked();
    const result = await relay(["switch", "codex:personal", "--no-start", "--json", "--yes", "--no-summary"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const value = JSON.parse(result.stdout);
    const commit = fixture.scratch.git("rev-parse", `refs/relay/jobs/${fixture.jobId}/latest`).trim();
    expect(value).toEqual({
      handoff_id: 1, checkpoint_sha: commit, prompt_path: join(fixture.relayHome, "jobs", fixture.jobId, "handoffs", "1", "prompt.md"),
      to_worker_id: null, outcome: "prepared", notes_source: "relay", mismatches: 0,
    });
    expect(readFileSync(value.prompt_path, "utf8")).toStartWith(`Continue relay job ${fixture.jobId}`);
  });

  test("a failure prints nothing on standard output", async () => {
    fixture = await switchFixture();
    expect((await relay(["switch", "codex:personal", "--json"])).stdout).toBe("");
  });
});

test("relay switch --help shows the usage and an example", async () => {
  const result = await runRelayInProcess(["switch", "--help"]);
  expect(result.stdout).toContain("  relay switch <provider[:account]>");
  expect(result.stdout).toContain("  relay switch codex:personal");
});
