// What add-relay-switch adds to relay run (task 6.3): the start prompt, a handoff when the job had
// earlier work, reusing a prepared handoff, the allow-list question, and the checkpoint when the
// agent exits.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tomlString } from "../../src/adapters/text";
import { startPrompt } from "../../src/handoff/render-prompt";
import { relayInstructions } from "../../src/run/instructions";
import { jobEvents, until, workers } from "../run/helpers";
import { relayIn, relayProcess, relayTerminal, Scenarios, switchFixture, type SwitchFixture } from "../handoff/switch-helpers";

setDefaultTimeout(60_000);

let fixture: SwitchFixture;
afterEach(() => fixture?.cleanup());

const record = () => join(fixture.scratch.root, "record.json");
const recorded = () => JSON.parse(readFileSync(record(), "utf8")) as { argv: string[]; input: string[] };

async function claudeWorked(): Promise<void> {
  fixture.scenarios.set({ claude: { turns: [{ steps: [{ write: "src/a.ts", content: "a\n" }, { say: "Done." }] }] } });
  expect((await relayIn(fixture, ["run", "claude:work", "--headless", "--prompt", "Go."])).code).toBe(0);
}

describe("Start prompt for a new job", () => {
  test("the first prompt names both instruction files and the check", async () => {
    fixture = await switchFixture();
    fixture.scratch.write("AGENTS.md", "# Agents\n");
    fixture.scratch.write("CLAUDE.md", "# Claude\n");
    fixture.scenarios.set({ claude: { turns: [{ steps: [{ say: "Done." }] }] } });
    const run = relayTerminal(fixture, ["run", "claude:work", "--headless", "--prompt", "Add the logout route.", "--check", "bun test"], { RELAY_FAKE_RECORD: record() });
    expect(await run.child.exited).toBe(0);
    const prompt = JSON.parse(recorded().input[0]!).message.content;
    expect(prompt).toBe(startPrompt({ jobId: fixture.jobId, title: "main", files: "AGENTS.md and CLAUDE.md", checks: ["bun test"], request: "Add the logout route." }));
  });
});

describe("A job with earlier work continues through a handoff", () => {
  test("Claude Code exited, Codex continues: no Stopping line, a handoff event from Claude Code's worker", async () => {
    fixture = await switchFixture();
    await claudeWorked();
    fixture.scenarios.set({ codex: { turns: [{ steps: [{ say: "Continuing." }] }] } });
    const result = await relayIn(fixture, ["run", "codex:personal", "--headless", "--prompt", "Go.", "--no-summary"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Using checkpoint [0-9a-f]{6} \(no changes since it was saved\)\nWrote \.relay\/checkpoint\.md\nStarting Codex · personal\nStarted Codex on codex:personal · session [0-9a-f]{8}\nContinuing on Codex\.\n/);
    const claude = workers(fixture).find((entry) => entry.account === "claude:work")!;
    expect(jobEvents(fixture).find((event) => event.type === "handoff")?.data).toMatchObject({ from_worker_id: claude.worker_id, to_target: "codex:personal" });
  });

  test("the same account again builds a handoff and starts a new session with the continuation prompt", async () => {
    fixture = await switchFixture();
    await claudeWorked();
    fixture.scenarios.set({ claude: { turns: [{ steps: [{ say: "Again." }] }] } });
    const result = await relayIn(fixture, ["run", "claude:work", "--headless", "--prompt", "Go.", "--no-summary"], { env: { RELAY_FAKE_RECORD: record() } });
    expect(result.code).toBe(0);
    expect(JSON.parse(recorded().input[0]!).message.content).toStartWith(`Continue relay job ${fixture.jobId}: main.`);
    expect(jobEvents(fixture).find((event) => event.type === "handoff")?.data).toMatchObject({ to_target: "claude:work" });
  });

  test("the instructions after a handoff are relay's instructions, byte for byte", async () => {
    fixture = await switchFixture();
    await claudeWorked();
    fixture.scenarios.set({ codex: Scenarios.fixture("codex-starts.json") });
    const settings = join(fixture.relayHome, "jobs", fixture.jobId, "handoff-settings.json");
    const value = JSON.parse(readFileSync(settings, "utf8"));
    await Bun.write(settings, JSON.stringify({ ...value, mode: "interactive", permission: null }));
    const run = relayTerminal(fixture, ["run", "codex:personal", "--no-summary"], { RELAY_FAKE_RECORD: record() });
    try {
      await until(() => run.output().includes("Continuing on Codex."));
      // Each start of the fake rewrites the record; the agent's own start is the one with -C.
      await until(() => { try { return recorded().argv.includes("-C"); } catch { return false; } });
      const argv = recorded().argv;
      expect(argv).toContain(`developer_instructions=${tomlString(relayInstructions(fixture.jobId, fixture.scratch.repo))}`);
      const instructions = argv.find((arg) => arg.startsWith("developer_instructions="))!;
      const checkpointLines = readFileSync(join(fixture.scratch.repo, ".relay", "checkpoint.md"), "utf8").split("\n").filter((line) => line.length > 20);
      expect(checkpointLines.filter((line) => instructions.includes(line))).toEqual([]);
    } finally {
      run.child.kill("SIGTERM");
      await run.child.exited;
    }
  });

  test("an agent still running under another relay run: exit 6", async () => {
    fixture = await switchFixture();
    fixture.scenarios.set({ claude: { turns: [{ steps: [{ say: "Working." }, { hang: true }] }] } });
    const run = relayProcess(fixture, ["run", "claude:work"]);
    try {
      await until(() => run.stdout().includes("Working."));
      expect(await relayIn(fixture, ["run", "codex:personal", "--headless", "--prompt", "Go."])).toEqual({
        code: 6, stdout: "", stderr: "relay: Claude Code · work is working on this job. To hand it over, run relay switch codex:personal.\n",
      });
    } finally {
      process.kill(-run.child.pid!, "SIGTERM");
      await run.exited;
    }
  });
});

describe("Reusing a prepared handoff", () => {
  test("a file changed after the handoff was prepared: relay builds a new handoff", async () => {
    fixture = await switchFixture();
    await claudeWorked();
    expect((await relayIn(fixture, ["switch", "codex:personal", "--no-start", "--no-summary"])).code).toBe(0);
    fixture.scratch.write("src/b.ts", "b\n");
    fixture.scenarios.set({ codex: { turns: [{ steps: [{ say: "Ok." }] }] } });
    const result = await relayIn(fixture, ["run", "codex:personal", "--headless", "--prompt", "Go.", "--no-summary"]);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("Using the prepared handoff");
    expect(result.stdout).toStartWith("Saved checkpoint ");
    expect(jobEvents(fixture).filter((event) => event.type === "handoff").map((event) => event.data.number)).toEqual([1, 2]);
  });
});

describe("Checkpoint when the agent exits", () => {
  test("an agent that changed files: Saved checkpoint, and its exit code", async () => {
    fixture = await switchFixture();
    fixture.scenarios.set({ claude: { turns: [{ steps: [{ write: "src/x.ts", content: "x\n" }, { write: "src/y.ts", content: "y\n" }, { say: "Done." }] }] } });
    const run = relayTerminal(fixture, ["run", "claude:work"]);
    await until(() => run.output().includes("Done."));
    run.type("\x04");
    expect(await run.child.exited).toBe(0);
    expect(run.output()).toMatch(/Claude Code · work stopped \(exit code 0\)\r?\nSaved checkpoint [0-9a-f]{6}\r?\n$/);
  });

  test("an agent that changed nothing: No changes since the checkpoint", async () => {
    fixture = await switchFixture();
    fixture.scenarios.set({ claude: { turns: [{ steps: [{ say: "Nothing." }, { exit: 1 }] }] } });
    const result = await relayIn(fixture, ["run", "claude:work", "--headless", "--prompt", "Go."]);
    expect(result.stdout).toMatch(/Claude Code · work stopped \(exit code 1\)\nNo changes since checkpoint [0-9a-f]{6}\n$/);
  });

  test("a secret in the work: phase 2's finding, no checkpoint, exit 4", async () => {
    fixture = await switchFixture();
    fixture.scenarios.set({ claude: { turns: [{ steps: [{ write: "src/key.ts", content: "const key = 'FAKE-SECRET:private-key';\n" }, { say: "Done." }] }] } });
    const before = fixture.scratch.git("for-each-ref", "refs/relay/");
    const result = await relayIn(fixture, ["run", "claude:work", "--headless", "--prompt", "Go."]);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("Stopped: possible secret in src/key.ts line 1 (private-key).");
    expect(fixture.scratch.git("for-each-ref", "refs/relay/")).toBe(before);
  });
});

test("an interactive Claude Code session ID is reused for the notes request", async () => {
  fixture = await switchFixture();
  fixture.scenarios.set({ claude: { turns: [{ steps: [{ write: "src/a.ts", content: "a\n" }, { say: "Working." }, { hang: true }] }] } });
  const run = relayProcess(fixture, ["run", "claude:work"], { RELAY_FAKE_RECORD: record() });
  try {
    await until(() => run.stdout().includes("Working."));
    fixture.scenarios.set({ claude: Scenarios.fixture("claude-answers-notes.json") });
    expect((await relayIn(fixture, ["switch", "codex:personal", "--no-start"])).code).toBe(0);
    const started = jobEvents(fixture).find((event) => event.type === "worker_started")!.data;
    const argv = recorded().argv;
    expect(argv[argv.indexOf("--resume") + 1]).toBe(started.provider_session_id as string);
    expect(argv).toContain("-p");
  } finally {
    await run.exited;
  }
});

describe("relay run asks instead of refusing", () => {
  test("the first run in a project adds the entry and asks nothing", async () => {
    fixture = await switchFixture();
    await Bun.write(join(fixture.relayHome, "config.toml"), '[accounts."claude:work"]\n\n[accounts."codex:personal"]\n');
    fixture.scenarios.set({ claude: { turns: [{ steps: [{ say: "Done." }] }] } });
    const result = await relayIn(fixture, ["run", "claude:work", "--headless", "--prompt", "Go."]);
    expect(result.stdout).toStartWith("Allowed claude:work on this project.\n");
    expect(readFileSync(join(fixture.relayHome, "config.toml"), "utf8")).toContain('allow = ["claude:work"]');
  });

  test("a run on a new account asks the first-handoff question naming OpenAI", async () => {
    fixture = await switchFixture({ allow: ["claude:work"] });
    await claudeWorked();
    fixture.scenarios.set({ codex: { turns: [{ steps: [{ say: "Ok." }] }] } });
    const result = await relayIn(fixture, ["run", "codex:personal", "--headless", "--prompt", "Go.", "--no-summary"], { answers: ["y"] });
    expect(result.code).toBe(0);
    expect(result.stdout).toStartWith("This sends the repository and the job notes to OpenAI through the account codex:personal. Continue? [y/N] ");
    expect(jobEvents(fixture).find((event) => event.type === "provider_allowed")?.data).toEqual({ account: "codex:personal", company: "OpenAI", how: "terminal" });
  });
});
