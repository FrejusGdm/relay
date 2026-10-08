// Claims compared with facts end to end (task 7.3): a false claim about bun test, a listed file
// that did not change, a file that does not exist, a check that rewrites a snapshot, and a job
// without checks.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jobEvents } from "../run/helpers";
import { relayProcess, Scenarios } from "../handoff/switch-helpers";
import { e2eFixture, type E2eFixture } from "./helpers";

setDefaultTimeout(120_000);

let fixture: E2eFixture;
afterEach(() => fixture?.cleanup());

const NOTES = (Scenarios.fixture("claude-answers-notes.json").turns![0]!.steps[0] as { say: string }).say;
const checkpointMd = () => readFileSync(join(fixture.scratch.repo, ".relay", "checkpoint.md"), "utf8");
const prompt = (n = 1) => readFileSync(join(fixture.relayHome, "jobs", fixture.jobId, "handoffs", String(n), "prompt.md"), "utf8");

async function run(args: string[]) {
  const child = relayProcess(fixture, args);
  const code = await child.exited;
  return { code, stdout: child.stdout(), stderr: child.stderr() };
}

function setChecks(commands: string[]): void {
  writeFileSync(join(fixture.relayHome, "jobs", fixture.jobId, "handoff-settings.json"), JSON.stringify({
    schema_version: 1, job_id: fixture.jobId, mode: "headless", permission: "edit-in-workspace",
    checks: commands.map((command) => ({ command, timeout_seconds: 600, added_at: new Date().toISOString() })), next_handoff: 1,
  }), { mode: 0o600 });
}

async function handoffWith(notes: string, checks: string[], writes = Scenarios.fixture("claude-edits-two-files.json")) {
  fixture.scenarios.set({ claude: writes });
  expect((await run(["run", "claude:personal", "--headless", "--prompt", "Add the callback."])).code).toBe(0);
  setChecks(checks);
  fixture.scenarios.set({ claude: { turns: [{ steps: [{ say: notes }] }] } });
  return run(["switch", "codex:personal", "--no-start"]);
}

test("a false claim about bun test comes first in the prompt and in checkpoint.md, and in the event", async () => {
  fixture = await e2eFixture();
  const result = await handoffWith(NOTES, ["bun test"]);
  expect(result.code).toBe(0);
  const sentence = "The notes say `bun test` passes. relay ran it: 231 passed, 1 failed (exit code 1).";
  expect(prompt().split("\n")[5]).toBe(`- ${sentence}`);
  expect(checkpointMd()).toContain(`### Differences between the notes and the repository\n\n- ${sentence}\n`);
  expect(jobEvents(fixture).findLast((event) => event.type === "handoff")!.data.mismatches).toEqual([
    { claim: "notes say `bun test` passes", found: "231 passed, 1 failed (exit code 1)" },
  ]);
});

test("a listed file that did not change, and a file that does not exist", async () => {
  fixture = await e2eFixture();
  const notes = NOTES.replace("- src/auth/google.ts", "- src/auth/google.ts\n- src/auth/session.ts")
    .replace("- Added the OAuth callback route in `src/auth/callback.ts`.", "- Added the OAuth callback route in `src/auth/callback.ts` and `src/auth/oauth.ts`.");
  // session.ts is in the checkpoint the worker starts from, so it does not change while it works.
  fixture.scratch.write("src/auth/session.ts", "export const session = 1;\n");
  expect((await run(["checkpoint"])).code).toBe(0);
  expect(await handoffWith(notes, [])).toMatchObject({ code: 0 });
  const work = fixture.scratch.git("rev-parse", `refs/relay/jobs/${fixture.jobId}/latest`).trim().slice(0, 6);
  expect(checkpointMd()).toContain("- The notes list `src/auth/session.ts` as changed, but it did not change while Claude Code worked.\n");
  expect(checkpointMd()).toContain(`- The notes mention \`src/auth/oauth.ts\`, which does not exist in checkpoint ${work}.\n`);
});

test("job files under .relay/ that the agent changed are not reported as unchanged", async () => {
  fixture = await e2eFixture();
  const notes = NOTES.replace("- src/auth/google.ts", "- src/auth/google.ts\n- .relay/task.md\n- .relay/decisions.md");
  const writes = Scenarios.fixture("claude-edits-two-files.json");
  writes.turns![0]!.steps.unshift(
    { write: ".relay/task.md", content: "# Task\n\nAdd the OAuth callback.\n" },
    { write: ".relay/decisions.md", content: "# Decisions\n\n- Sessions live in signed cookies.\n" },
  );
  expect(await handoffWith(notes, [], writes)).toMatchObject({ code: 0 });
  expect(checkpointMd()).not.toContain("did not change while");
  expect(jobEvents(fixture).findLast((event) => event.type === "handoff")!.data.mismatches).toEqual([]);
});

test("a check that rewrites a snapshot: reported, not reverted, and the work checkpoint holds the old file", async () => {
  fixture = await e2eFixture();
  fixture.scratch.write("test/__snapshots__/a.snap", "old\n");
  const result = await handoffWith(NOTES, ["echo new > test/__snapshots__/a.snap"]);
  expect(result.code).toBe(0);
  expect(checkpointMd()).toContain("Running the checks changed: test/__snapshots__/a.snap.\n");
  expect(readFileSync(join(fixture.scratch.repo, "test/__snapshots__/a.snap"), "utf8")).toBe("new\n");
  expect(fixture.scratch.git("show", `refs/relay/jobs/${fixture.jobId}/latest:test/__snapshots__/a.snap`)).toBe("old\n");
});

test("a job without checks says how to add them, and the prompt has no check line", async () => {
  fixture = await e2eFixture();
  const result = await handoffWith(NOTES, []);
  expect(result.stdout).not.toContain("Ran ");
  expect(checkpointMd()).toContain('No checks are recorded for this job. Add them with relay switch <account> --check "<command>".\n');
  expect(prompt()).not.toContain("run by relay at");
});
