// The basic switch from Claude Code to Codex (task 7.1): relay run in one pseudo-terminal, relay
// switch in another, the real gitleaks, and the person's repository untouched.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { jobEvents, until, workers } from "../run/helpers";
import { relayTerminal, Scenarios } from "../handoff/switch-helpers";
import { e2eFixture, expectPersonUnchanged, golden, normalize, type E2eFixture } from "./helpers";

setDefaultTimeout(120_000);

let fixture: E2eFixture;
afterEach(() => fixture?.cleanup());

test("Switch from Claude Code to Codex", async () => {
  fixture = await e2eFixture();
  const record = join(fixture.scratch.root, "record.json");
  fixture.scenarios.set({ claude: Scenarios.fixture("claude-edits-two-files.json") });
  const a = relayTerminal(fixture, ["run", "claude:personal", "--check", "bun test"], { RELAY_FAKE_RECORD: record });
  try {
    await until(() => a.output().includes("The callback is done."), 30_000);
    fixture.scenarios.set({ claude: Scenarios.fixture("claude-answers-notes.json"), codex: Scenarios.fixture("codex-starts.json") });
    const b = relayTerminal(fixture, ["switch", "codex:personal"]);
    expect(await b.child.exited).toBe(0);
    const lines = b.output().replaceAll("\r", "");
    const work = fixture.scratch.git("rev-parse", `refs/relay/jobs/${fixture.jobId}/latest`).trim();
    expect(lines).toBe([
      "Stopping Claude Code · personal", `Saved checkpoint ${work.slice(0, 6)}`, "Asking Claude Code for handoff notes",
      "Ran bun test · 231 passed, 1 failed", "Found 1 difference between the notes and the repository", "Wrote .relay/checkpoint.md",
      "Starting Codex · personal", "Continuing on Codex.", "",
    ].join("\n"));
    await until(() => a.output().includes("Reading .relay/checkpoint.md"));
    expect(a.output()).toContain("Continuing on Codex.");

    // The refs: the work checkpoint, latest, and the handoff.
    const refs = fixture.scratch.git("for-each-ref", "--format=%(refname)", `refs/relay/jobs/${fixture.jobId}/`).split("\n").filter(Boolean);
    expect(refs).toContain(`refs/relay/jobs/${fixture.jobId}/handoffs/1`);
    expect(refs).toContain(`refs/relay/jobs/${fixture.jobId}/latest`);
    expect(fixture.scratch.git("log", "-1", "--format=%(trailers:key=Relay-Kind,valueonly)", work).trim()).toBe("handoff");

    // checkpoint.md and the prompt, against golden files.
    const checkpoint = readFileSync(join(fixture.scratch.repo, ".relay", "checkpoint.md"), "utf8");
    expect(normalize(checkpoint, fixture)).toBe(golden("switch-basic-checkpoint.md", normalize(checkpoint, fixture)));
    const promptPath = join(fixture.relayHome, "jobs", fixture.jobId, "handoffs", "1", "prompt.md");
    const prompt = readFileSync(promptPath, "utf8");
    expect(normalize(prompt, fixture)).toBe(golden("switch-basic-prompt.md", normalize(prompt, fixture)));
    expect(fixture.scratch.git("show", `refs/relay/jobs/${fixture.jobId}/handoffs/1:.relay/checkpoint.md`)).toBe(checkpoint);

    // What fake Codex received: its own profile, no Anthropic variable, the worktree root, the prompt.
    const seen = JSON.parse(readFileSync(record, "utf8")) as { argv: string[]; cwd: string; env_names: string[]; env: Record<string, string | null> };
    expect(seen.env.CODEX_HOME).toBe(join(fixture.relayHome, "profiles", "codex-personal"));
    expect(seen.env_names.filter((name) => name.startsWith("ANTHROPIC_"))).toEqual([]);
    expect(seen.cwd).toBe(fixture.scratch.repo);
    expect(seen.argv.at(-1)).toBe(prompt);

    const types = jobEvents(fixture).map((event) => event.type);
    const from = types.lastIndexOf("worker_ended");
    expect(types.slice(from)).toEqual(["worker_ended", "checkpoint_saved", "handoff_notes", "check_run", "handoff", "worker_started"]);
    const codex = workers(fixture).find((entry) => entry.account === "codex:personal")!;
    expect(JSON.parse(readFileSync(join(fixture.scratch.repo, ".relay", "state.json"), "utf8")).current_worker).toMatchObject({ id: codex.worker_id, from_handoff: 1 });
    expectPersonUnchanged(fixture, ["src/auth/callback.ts", "src/auth/google.ts"]);
  } finally {
    a.child.kill("SIGTERM");
    await a.child.exited;
  }
});
