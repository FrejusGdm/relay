// Shared steps for the tests of relay checkpoints and relay rollback: a scratch repository with a
// job, relay run in the same process, and readers for refs, events and the person's state. With
// RELAY_DOC_SAMPLES=1, every run prints its command and exact output for docs/checkpoints.md.
import { expect } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runRelayInProcess, type RelayResult } from "./cli";
import { captureState, type RepoState } from "./invariants";
import { makeScratchRepo, type ScratchRepo } from "./scratch-repo";

// A scratch repository with a job whose baseline is saved. `limitMb` writes the size limit to
// config.toml first.
export async function setUpJob(kind: "full" | "empty" = "full", limitMb?: number): Promise<ScratchRepo> {
  const scratch = makeScratchRepo(kind);
  if (limitMb !== undefined) {
    mkdirSync(scratch.relayHome, { mode: 0o700 });
    writeFileSync(join(scratch.relayHome, "config.toml"), `[checkpoint]\nmax_file_size_mb = ${limitMb}\n`, { mode: 0o600 });
  }
  expect((await relay(scratch, ["init"], { quiet: true })).code).toBe(0);
  return scratch;
}

// Runs relay in the repository. `terminal` simulates a terminal in which the person types the
// answer; `quiet` prints no documentation sample.
export async function relay(
  scratch: ScratchRepo,
  args: string[],
  options: { cwd?: string; terminal?: { answer: string | null; beforeAnswer?: () => void }; quiet?: boolean } = {},
): Promise<RelayResult> {
  const result = await runRelayInProcess(args, {
    cwd: options.cwd ?? scratch.repo,
    relayHome: scratch.relayHome,
    terminal: options.terminal,
  });
  if (process.env.RELAY_DOC_SAMPLES === "1" && options.quiet !== true) {
    const shown = args.map((arg) => (/[\s"]/.test(arg) ? JSON.stringify(arg) : arg));
    // The person's answer appears after the question, as the terminal shows it.
    const answer = options.terminal?.answer;
    const stdout =
      typeof answer === "string" ? result.stdout.replace(/(\[y\/N\] |Type yes to continue: )/, `$1${answer}\n`) : result.stdout;
    console.log(["$ relay", ...shown].join(" ") + "\n" + stdout + result.stderr + `(exit code ${result.code})\n`);
  }
  return result;
}

export const state = (scratch: ScratchRepo, root = scratch.repo) =>
  JSON.parse(readFileSync(join(root, ".relay", "state.json"), "utf8"));
export const jobId = (scratch: ScratchRepo) => state(scratch).job_id as string;
export const ref = (scratch: ScratchRepo, n: number | "latest") =>
  n === "latest" ? `refs/relay/jobs/${jobId(scratch)}/latest` : `refs/relay/jobs/${jobId(scratch)}/checkpoints/${n}`;
export const sha = (scratch: ScratchRepo, name: string) => scratch.git("rev-parse", name).trim();
export const relayRefs = (scratch: ScratchRepo) =>
  scratch.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/relay/").split("\n").filter(Boolean);
export const eventsText = (scratch: ScratchRepo) => readFileSync(join(scratch.repo, ".relay", "events.jsonl"), "utf8");
export const events = (scratch: ScratchRepo) =>
  eventsText(scratch).split("\n").filter(Boolean).map((line) => JSON.parse(line));

// captureState skips the files in .relay/; the status line of the ignored .relay/ folder is
// removed here too.
export function personState(root: string): RepoState {
  const captured = captureState(root);
  return { ...captured, status: captured.status.filter((entry) => !entry.includes(".relay/")) };
}

// Everything of the person's except the working-tree files and git status, which a rollback
// changes on purpose.
export function personGitState(root: string): Omit<RepoState, "files" | "status"> {
  const { files: _files, status: _status, ...rest } = captureState(root);
  return rest;
}
