// Handoff notes end to end (task 7.2): the usage-limit skip, the time-out, free-form notes,
// invisible characters, a secret in the notes followed by a retry with --no-summary, and a request
// for permission while the agent writes its notes.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { filesContaining, fakeGithubToken } from "../helpers/secrets";
import { jobEvents } from "../run/helpers";
import { relayProcess, Scenarios } from "../handoff/switch-helpers";
import { e2eFixture, type E2eFixture } from "./helpers";

setDefaultTimeout(120_000);

let fixture: E2eFixture;
afterEach(() => fixture?.cleanup());

const NOTES = Scenarios.fixture("claude-answers-notes.json").turns![0]!.steps[0] as { say: string };
const checkpointMd = () => readFileSync(join(fixture.scratch.repo, ".relay", "checkpoint.md"), "utf8");
const notesEvent = () => jobEvents(fixture).findLast((event) => event.type === "handoff_notes")!.data;

async function run(args: string[], env: Record<string, string> = {}) {
  const child = relayProcess(fixture, args, env);
  const code = await child.exited;
  return { code, stdout: child.stdout(), stderr: child.stderr() };
}

async function claudeWorked(scenario = Scenarios.fixture("claude-edits-two-files.json")) {
  fixture.scenarios.set({ claude: scenario });
  return run(["run", "claude:personal", "--headless", "--prompt", "Add the callback."]);
}

test("an agent at its usage limit is not asked: relay builds the notes", async () => {
  fixture = await e2eFixture();
  expect((await claudeWorked(Scenarios.fixture("claude-hits-limit.json"))).code).toBe(23);
  const result = await run(["switch", "codex:personal", "--no-start"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Claude Code is at its usage limit, so relay built the notes from the event log and the repository.\n");
  expect(result.stdout).not.toContain("Asking Claude Code");
  expect(notesEvent()).toMatchObject({ outcome: "skipped", reason: "Claude Code was at its usage limit" });
  expect(checkpointMd()).toContain("\n## Notes built by relay\n\nClaude Code did not write notes: Claude Code was at its usage limit.");
  expect(checkpointMd()).toContain("and stopped at its usage limit.\n");
});

test("an agent that does not answer within the time limit is stopped, and relay builds the notes", async () => {
  fixture = await e2eFixture();
  expect((await claudeWorked()).code).toBe(0);
  fixture.scenarios.set({ claude: Scenarios.fixture("claude-hangs-on-notes.json") });
  const result = await run(["switch", "codex:personal", "--no-start"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Claude Code did not answer within 10 seconds. relay built the notes from the event log and the repository.\n");
  expect(notesEvent()).toMatchObject({ outcome: "timed_out" });
});

test("notes in free form are kept whole and have no claims", async () => {
  fixture = await e2eFixture();
  expect((await claudeWorked()).code).toBe(0);
  fixture.scenarios.set({ claude: { turns: [{ steps: [{ say: "I added the callback and the tests pass." }] }] } });
  expect((await run(["switch", "codex:personal", "--no-start"])).code).toBe(0);
  expect(checkpointMd()).toContain("Notes: written by Claude Code, checked by relay. The notes did not use the requested sections.\n");
  expect(checkpointMd()).toContain("I added the callback and the tests pass.");
  expect(jobEvents(fixture).findLast((event) => event.type === "handoff")!.data).toMatchObject({ claims_count: 0, notes_source: "agent" });
});

test("invisible characters in the notes are removed and counted", async () => {
  fixture = await e2eFixture();
  expect((await claudeWorked()).code).toBe(0);
  const hidden = "\u{E0041}\u{E0042}\u{E0043}‮";
  fixture.scenarios.set({ claude: { turns: [{ steps: [{ say: NOTES.say.replace("- None.", `- None.${hidden}`) }] }] } });
  const result = await run(["switch", "codex:personal", "--no-start"]);
  expect(result.stdout).toContain("Removed 4 invisible characters from Claude Code's notes.\n");
  expect(checkpointMd()).not.toMatch(/[\u{E0041}-\u{E0043}‮]/u);
  expect(jobEvents(fixture).findLast((event) => event.type === "handoff")!.data.invisible_removed).toBe(4);
});

test("a secret in the notes stops the switch; a retry with --no-summary uses the same checkpoint", async () => {
  fixture = await e2eFixture();
  expect((await claudeWorked()).code).toBe(0);
  const token = fakeGithubToken();
  const notes = Scenarios.fixture("claude-notes-with-secret.json").turns![0]!.steps[0] as { say: string };
  fixture.scenarios.set({ claude: { turns: [{ steps: [{ say: notes.say.replace("FAKE-SECRET:generic-api-key", token) }] }] } });
  const before = { checkpoint: checkpointMd(), state: readFileSync(join(fixture.scratch.repo, ".relay", "state.json"), "utf8") };
  const refused = await run(["switch", "codex:personal", "--no-start"]);
  expect(refused.code).toBe(4);
  expect(refused.stderr).toMatch(/^relay: Stopped: possible secret in Claude Code's handoff notes, line 12 \(github-pat\)\.\nrelay: Nothing was written or sent\. Claude Code is stopped, and your work is saved in checkpoint [0-9a-f]{6}\.\nRun "relay switch codex:personal --no-summary" to hand off without Claude Code's notes\.\n$/);
  expect(checkpointMd()).toBe(before.checkpoint);
  expect(fixture.scratch.git("for-each-ref", `refs/relay/jobs/${fixture.jobId}/handoffs/`)).toBe("");
  const checkpoints = fixture.scratch.git("for-each-ref", `refs/relay/jobs/${fixture.jobId}/checkpoints/`);

  const retry = await run(["switch", "codex:personal", "--no-start", "--no-summary"]);
  expect(retry.code).toBe(0);
  expect(retry.stdout).toMatch(/^Using checkpoint [0-9a-f]{6} \(no changes since it was saved\)\n/);
  expect(fixture.scratch.git("for-each-ref", `refs/relay/jobs/${fixture.jobId}/checkpoints/`)).toBe(checkpoints);
  for (const output of [refused.stdout, refused.stderr, retry.stdout, retry.stderr]) expect(output).not.toContain(token);
  expect(filesContaining(join(fixture.scratch.repo, ".relay"), token)).toEqual([]);
  // The provider's own profile folder is the fake's, not relay's.
  expect(filesContaining(fixture.relayHome, token).filter((path) => !path.includes("/profiles/"))).toEqual([]);
});

test("a request for permission during the notes request is never answered", async () => {
  fixture = await e2eFixture();
  expect((await claudeWorked()).code).toBe(0);
  fixture.scenarios.set({ claude: Scenarios.fixture("claude-asks-approval-on-notes.json") });
  const result = await run(["switch", "codex:personal", "--no-start"]);
  expect(result.code).toBe(0);
  expect(notesEvent()).toMatchObject({ outcome: "failed", reason: "the request failed: the agent asked for permission" });
  expect(checkpointMd()).toContain("Notes: built by relay: the request failed: the agent asked for permission\n");
});
