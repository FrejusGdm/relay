import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckResult } from "../../src/handoff/checks";
import type { Mismatch } from "../../src/handoff/claims";
import { parseNotes } from "../../src/handoff/notes-parse";
import { renderCheckpoint } from "../../src/handoff/render-checkpoint";
import { continuationPrompt, instructionFileNames, startPrompt, type ContinuationInput } from "../../src/handoff/render-prompt";
import { relayInstructions } from "../../src/run/instructions";

const ROOT = join(import.meta.dir, "..", "..");
const SPECS = join(ROOT, "openspec", "changes", "add-relay-switch", "specs");
// The block after `marker` in a spec file, without the two spaces of the list item.
function specBlock(file: string, marker: string): string {
  const text = readFileSync(join(SPECS, file), "utf8");
  const start = text.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const block = /\n {2}```\n([\s\S]*?)\n {2}```/.exec(text.slice(start))![1]!;
  return block.split("\n").map((line) => line.replace(/^ {2}/, "")).join("\n");
}

const BUN_TEST: CheckResult = {
  command: "bun test", outcome: "failed", exitCode: 1, signal: null, seconds: 41, counts: { passed: 231, failed: 1, skipped: 0 },
  logPath: "", excerpt: [], changedFiles: [], timeoutSeconds: 600, ranAt: new Date("2026-10-07T14:20:10Z"),
};
const MISMATCH: Mismatch = {
  kind: "check", claim: "notes say `bun test` passes", found: "231 passed, 1 failed (exit code 1)",
  sentence: "The notes say `bun test` passes. relay ran it: 231 passed, 1 failed (exit code 1).",
};
const example = (changes: Partial<ContinuationInput> = {}): ContinuationInput => ({
  jobId: "3f9a2c1d", title: "Build authentication", from: { id: "claude:personal", provider: "claude" },
  until: new Date("2026-10-07T14:19:05Z"), stoppedByRelay: true, checkpoint: "912ec1f".padEnd(40, "2"),
  mismatches: [MISMATCH], diff: { files: 2, added: 50, removed: 3 }, base: "86300b0".padEnd(40, "1"),
  checks: [BUN_TEST], notesSource: "agent", nonce: "5b9e04c1", files: "AGENTS.md and CLAUDE.md", ...changes,
});

describe("The start prompt", () => {
  test("both instruction files and one check, byte for byte", () => {
    expect(startPrompt({ jobId: "3f9a2c1d", title: "Build authentication", files: "AGENTS.md and CLAUDE.md", checks: ["bun test"] }))
      .toBe(specBlock("run-continuation/spec.md", "Start prompt with both instruction files and one check"));
  });

  test("without instruction files the steps are numbered 1 and 2", () => {
    const prompt = startPrompt({ jobId: "3f9a2c1d", title: "Build authentication", files: null, checks: [] });
    expect(prompt).toBe("Start relay job 3f9a2c1d: Build authentication.\n\n1. Read .relay/task.md: the goal, the acceptance criteria and the plan.\n2. Work on the task. Keep the Plan, Done, In progress and Left to do sections of .relay/task.md current.");
  });

  test("a request given with --prompt comes last", () => {
    expect(startPrompt({ jobId: "3f9a2c1d", title: "T", files: "AGENTS.md", checks: ["bun test", "bun run lint"], request: "Add the logout route." }))
      .toEndWith("relay runs these checks when the job moves to another agent: `bun test`, `bun run lint`.\n\nYour request: Add the logout route.");
  });
});

describe("The continuation prompt", () => {
  test("the example of the handoff-content spec, byte for byte", () => {
    expect(continuationPrompt(example())).toBe(specBlock("handoff-content/spec.md", "Prompt for the example handoff"));
  });

  test("notes built by relay change steps 4 and 5", () => {
    const prompt = continuationPrompt(example({ notesSource: "relay", mismatches: [] }));
    expect(prompt).toContain("\n4. No agent wrote notes this time. Check that the items under Done in .relay/task.md hold in the repository. Write the results to .relay/verify.md as a table with the columns Claim, Holds (yes, no or unclear) and Evidence.\n");
    expect(prompt).toContain("\n5. Continue the task from the In progress and Left to do sections of .relay/task.md.\n");
    expect(prompt).toContain("\n- relay found no differences between the notes and the repository.\n");
  });

  test("more than five differences: the first five and a count", () => {
    const mismatches = Array.from({ length: 7 }, (_, i) => ({ ...MISMATCH, sentence: `Difference ${i + 1}.` }));
    const prompt = continuationPrompt(example({ mismatches }));
    expect(prompt).toContain("- Difference 5.\n- relay found 2 more differences. They are listed in .relay/checkpoint.md.\n");
    expect(prompt).not.toContain("Difference 6.");
  });

  test("a repository without commits: git status only, and no base commit", () => {
    const prompt = continuationPrompt(example({ base: null }));
    expect(prompt).toContain("\n3. Inspect the work: run `git status`.\n");
    expect(prompt).toContain("- 2 files changed since the job started (50 lines added, 3 removed).\n");
  });

  test("the four combinations of AGENTS.md and CLAUDE.md", () => {
    for (const [names, expected] of [[["AGENTS.md", "CLAUDE.md"], "AGENTS.md and CLAUDE.md"], [["AGENTS.md"], "AGENTS.md"], [["CLAUDE.md"], "CLAUDE.md"], [[], null]] as const) {
      const folder = mkdtempSync(join(realpathSync(tmpdir()), "relay-prompt-"));
      for (const name of names) writeFileSync(join(folder, name), "x\n");
      const files = instructionFileNames(folder);
      expect(files).toBe(expected);
      const prompt = continuationPrompt(example({ files }));
      if (files === null) {
        expect(prompt).not.toContain("project instructions");
        expect(prompt).toContain("\n4. Continue the task from the current step");
      } else expect(prompt).toContain(`\n1. Read the project instructions in ${files}.\n`);
    }
  });

  test("relay saved, not stopped, the agent's work after it exited by itself", () => {
    expect(continuationPrompt(example({ stoppedByRelay: false }))).toContain("until 14:19 UTC. relay saved checkpoint 912ec1. You are the next agent.");
  });

  test("the prompt stays within 6,000 characters", () => {
    const checks = Array.from({ length: 30 }, (_, i) => ({ ...BUN_TEST, command: `bun test ${String(i).padStart(2, "0")} ${"x".repeat(400)}` }));
    const prompt = continuationPrompt(example({ checks }));
    expect(prompt.length).toBeLessThanOrEqual(6000);
    expect(prompt).toMatch(/\n- relay ran \d+ more checks\. They are listed in \.relay\/checkpoint\.md\.\n/);
    expect(prompt).toEndWith("say so in .relay/verify.md.");
  });

  test("a title with line breaks stays on one line", () => {
    expect(continuationPrompt(example({ title: "A\n## B" })).split("\n")[0]).toBe("Continue relay job 3f9a2c1d: A ## B.");
  });
});

describe("Prompt and instructions hold only relay's text", () => {
  test("the instructions are phase 3's text", () => {
    expect(relayInstructions("3f9a2c1d", "/p")).toStartWith("You are working inside relay job 3f9a2c1d.");
  });

  test("markers in the notes, a commit message, a command line and check output stay in checkpoint.md", () => {
    const markers = ["MARKER-NOTES", "MARKER-COMMIT", "MARKER-COMMAND", "MARKER-OUTPUT"];
    const notes = parseNotes(`## Done\n- ${markers[0]}\n## Claims to verify\n- \`bun test\` passes. ${markers[0]}`);
    const check = { ...BUN_TEST, excerpt: [`failed ${markers[3]}`] };
    const checkpoint = renderCheckpoint({
      jobId: "3f9a2c1d", handoff: 3, writtenAt: new Date("2026-10-07T14:19:30Z"), title: "Build authentication",
      from: { id: "claude:personal", provider: "claude", name: "personal" }, to: { id: "codex:personal", provider: "codex", name: "personal" },
      worker: { startedAt: null, endedAt: null, howItEnded: "stopped by relay switch", startCheckpoint: null, filesChanged: [], commits: 0 },
      worktreeRoot: "/p", branch: "main", base: null, checkpoint: { number: 7, commit: "912ec1f".padEnd(40, "2") },
      notes: { source: "agent", parsed: notes }, checks: [check], mismatches: [MISMATCH], diffStat: [],
      instructionFiles: null, commitLines: [`a1b2c3d ${markers[1]}`], eventLines: [`- 14:11 ran \`echo ${markers[2]}\`, exit code 0`],
      random: () => "5b9e04c1",
    }).text;
    const prompt = continuationPrompt(example({ checks: [check] }));
    const instructions = relayInstructions("3f9a2c1d", "/p");
    const fenced = checkpoint.slice(checkpoint.indexOf("<<<relay-untrusted-notes-5b9e04c1"), checkpoint.indexOf("relay-untrusted-notes-5b9e04c1>>>"));
    for (const marker of markers) {
      expect(prompt).not.toContain(marker);
      expect(instructions).not.toContain(marker);
      expect(fenced).toContain(marker);
    }
  });
});
