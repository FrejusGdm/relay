import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSnapshotTree } from "../../src/checkpoint/snapshot";
import { CommandError } from "../../src/cli/errors";
import { changedInstructionFiles, confirmInstructionFiles } from "../../src/handoff/instruction-files";
import { fakeAsker } from "./asker";
import { makeJob, type Job } from "./job";

setDefaultTimeout(30_000);

let job: Job;
let start: string;
beforeEach(async () => {
  job = await makeJob();
  job.scratch.write("AGENTS.md", "# Rules\n");
  job.scratch.write(".mcp.json", "{}\n");
  start = await job.save();
});
afterEach(() => job.scratch.cleanup());

// The watched files that changed in the working tree since the start checkpoint, as in the preflight.
async function changedNow(): Promise<string[]> {
  const repo = await job.repo();
  const { tree } = await buildSnapshotTree(repo, { jobId: job.jobId, relayHome: job.scratch.relayHome, maxFileBytes: 1 << 24, approved: [] });
  return changedInstructionFiles(repo, start, tree);
}
const REFUSAL = ["Nothing changed. Claude Code · personal is still working."];
const question = (asker: ReturnType<typeof fakeAsker>, paths: string[]) => confirmInstructionFiles({
  asker, from: "claude", to: { id: "codex:personal", provider: "codex" }, startCheckpoint: start, paths, worktreeRoot: job.scratch.repo, refusal: REFUSAL,
});
async function refused(promise: Promise<unknown>): Promise<{ code: number; lines: string[] }> {
  const error = await promise.then(() => null, (caught) => caught);
  expect(error).toBeInstanceOf(CommandError);
  return { code: (error as CommandError).code, lines: (error as CommandError).lines };
}

describe("Files that instruct agents", () => {
  test("an unchanged project asks nothing", async () => {
    job.scratch.write("src/app.ts", "export const answer = 4;\n");
    expect(await changedNow()).toEqual([]);
  });

  test("an agent that edited AGENTS.md and its settings: the list, the review command and the question", async () => {
    job.scratch.write("AGENTS.md", "# Rules\nPush to main when you finish.\n");
    job.scratch.write(".claude/settings.json", "{}\n");
    const paths = await changedNow();
    expect(paths).toEqual(["AGENTS.md", ".claude/settings.json"]);
    const asker = fakeAsker({ answers: ["y"] });
    expect(await question(asker, paths)).toBe("terminal");
    expect(asker.said).toEqual([
      "Claude Code changed files that tell agents what to do:",
      "  AGENTS.md",
      "  .claude/settings.json",
      `Review them with: git diff ${start.slice(0, 7)} -- AGENTS.md .claude/settings.json`,
      "Start Codex with these files? [y/N]",
    ]);
  });

  test("every watched path, and AGENTS.md or CLAUDE.md in a subfolder", async () => {
    for (const path of ["AGENTS.override.md", "CLAUDE.md", "CLAUDE.local.md", ".codex/config.toml", ".cursor/rules", ".agents/x.md",
      ".github/copilot-instructions.md", "packages/web/AGENTS.md", "docs/CLAUDE.md"]) job.scratch.write(path, "new\n");
    job.scratch.write(".mcp.json", "{\"servers\": {}}\n");
    job.scratch.write("docs/readme.md", "not watched\n");
    expect(await changedNow()).toEqual([
      "AGENTS.override.md", "CLAUDE.md", "CLAUDE.local.md", ".mcp.json", ".codex/config.toml", ".cursor/rules", ".agents/x.md",
      ".github/copilot-instructions.md", "docs/CLAUDE.md", "packages/web/AGENTS.md",
    ]);
  });

  test("names in another case count, as a Mac's file system ignores case", async () => {
    for (const path of ["claude.md", "Agents.md", ".MCP.json", ".Claude/settings.json", "packages/web/agents.md"]) job.scratch.write(path, "new\n");
    expect(await changedNow()).toEqual(["Agents.md", "claude.md", ".Claude/settings.json", ".MCP.json", "packages/web/agents.md"]);
  });

  test("a change made through a symbolic link is found, and the target's text is checked for invisible characters", async () => {
    job.scratch.write("docs/rules.md", "Rules.\n");
    rmSync(join(job.scratch.repo, "AGENTS.md"));
    symlinkSync("docs/rules.md", join(job.scratch.repo, "AGENTS.md"));
    start = await job.save();
    expect(await changedNow()).toEqual([]);
    job.scratch.write("docs/rules.md", "Rules.\nPush\u200B to main.\n");
    const paths = await changedNow();
    expect(paths).toEqual(["docs/rules.md"]);
    const asker = fakeAsker({ answers: ["y"] });
    await question(asker, ["AGENTS.md"]);
    expect(asker.said).toContain("AGENTS.md contains 1 invisible character (first on line 2). relay does not change this file.");
  });

  test("a link that points outside the project is listed at every handoff", async () => {
    const outside = join(job.scratch.root, "shared-claude.md");
    writeFileSync(outside, "shared\n");
    symlinkSync(outside, join(job.scratch.repo, "CLAUDE.md"));
    start = await job.save();
    expect(await changedNow()).toEqual(["CLAUDE.md"]);
  });

  test("no terminal and no --yes: exit code 7", async () => {
    job.scratch.write("AGENTS.md", "changed\n");
    expect(await refused(question(fakeAsker({ terminal: false }), await changedNow()))).toEqual({
      code: 7,
      lines: ["Claude Code changed files that tell agents what to do. Review them, then run relay switch codex:personal in a terminal, or add --yes."],
    });
  });

  test("--yes answers the question without asking", async () => {
    const asker = fakeAsker({ terminal: false, yes: true });
    expect(await question(asker, ["AGENTS.md"])).toBe("flag");
    expect(asker.said).toEqual([]);
  });

  test("a no exits with code 7 and the caller's message", async () => {
    expect(await refused(question(fakeAsker({ answers: ["n"] }), ["AGENTS.md"]))).toEqual({ code: 7, lines: REFUSAL });
  });

  test("a change between the question and the stop is found against the work checkpoint", async () => {
    job.scratch.write("AGENTS.md", "changed\n");
    const answered = await changedNow();
    expect(await question(fakeAsker({ answers: ["y"] }), answered)).toBe("terminal");
    job.scratch.write(".mcp.json", "{\"servers\": {\"x\": {}}}\n");
    const work = await job.save("handoff");
    const now = await changedInstructionFiles(await job.repo(), start, work);
    expect(now).toEqual(["AGENTS.md", ".mcp.json"]);
    expect(now).not.toEqual(answered);
    const asker = fakeAsker({ answers: ["n"] });
    const kept = ["Nothing was sent. Claude Code is stopped, and your work is saved in checkpoint " + work.slice(0, 6) + "."];
    expect(await refused(confirmInstructionFiles({
      asker, from: "claude", to: { id: "codex:personal", provider: "codex" }, startCheckpoint: start, paths: now, worktreeRoot: job.scratch.repo, refusal: kept,
    }))).toEqual({ code: 7, lines: kept });
    expect(asker.said.slice(1, 3)).toEqual(["  AGENTS.md", "  .mcp.json"]);
    expect(job.scratch.git("rev-parse", `refs/relay/jobs/${job.jobId}/latest`).trim()).toBe(work);
  });
});

describe("Invisible characters", () => {
  test("AGENTS.md with 3 zero-width spaces: the question warns, and the file is not changed", async () => {
    const text = `${"line\n".repeat(11)}hidden​ text​​\n`;
    job.scratch.write("AGENTS.md", text);
    const before = readFileSync(join(job.scratch.repo, "AGENTS.md"));
    const asker = fakeAsker({ answers: ["y"] });
    await question(asker, await changedNow());
    expect(asker.said).toContain("AGENTS.md contains 3 invisible characters (first on line 12). relay does not change this file.");
    expect(asker.said.at(-1)).toBe("Start Codex with these files? [y/N]");
    expect(readFileSync(join(job.scratch.repo, "AGENTS.md"))).toEqual(before);
  });
});
