// relay init (the job-files spec and design.md section 16): sets up a job in the git checkout
// that holds the current folder. Every check runs before anything is created, so a refusal
// changes nothing. The job then saves its first checkpoint, the baseline; when that is stopped,
// for example by the secret scan, the job stays set up and the next relay checkpoint saves it.
import { existsSync, lstatSync, mkdirSync, rmdirSync, rmSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { saveCheckpoint } from "../../checkpoint/save";
import { onInterrupt } from "../../core/cleanup";
import { printable } from "../../core/quote";
import { VERSION } from "../../core/version";
import { openRepository, RepositoryError, type Repository } from "../../git/repo";
import { git } from "../../git/run";
import { recordTrust } from "../../git/trust";
import { appendEvent, createEventLog, type JobRef } from "../../job/events";
import { addExcludeLine, excludePath } from "../../job/exclude";
import { taskTemplate, writeTemplates } from "../../job/files";
import { drawJobId } from "../../job/id";
import { JOB_FILES } from "../../job/names";
import { readState, stateText, writeState, type JobState } from "../../job/state";
import { checkGitleaks, scanTexts } from "../../secrets/scan";
import { removeInvisible } from "../../text/invisible";
import { CommandError } from "../errors";
import { ExitCode } from "../exit-codes";
import { fileLines } from "./checkpoint";
import type { CommandContext } from "./registry";

const TITLE_LIMIT = 120;

export async function init(ctx: CommandContext): Promise<number> {
  try {
    const { repo, jobId, lines } = await setUp(ctx);
    let baseline;
    try {
      baseline = await saveCheckpoint(repo, {
        relayHome: ctx.relayHome,
        command: "init",
        kind: "baseline",
        maxFileSizeMb: ctx.config.checkpoint.maxFileSizeMb,
        env: ctx.env,
      });
    } catch (error) {
      // The job is set up whatever stopped the baseline, for example a git time-out, so relay says so.
      const notSaved = `relay is set up (job ${jobId}), but the baseline checkpoint was not saved.`;
      if (error instanceof CommandError) return fail(ctx, error.code, [notSaved, ...error.lines]);
      if (error instanceof Error) return fail(ctx, ExitCode.Failed, [notSaved, ...error.message.split("\n").map(printable)]);
      throw error;
    }
    const saved = baseline.saved ? [`Saved checkpoint ${baseline.number} · ${baseline.commit.slice(0, 7)} (${baseline.kind})`] : [];
    const all = [...lines, ...saved, ...fileLines(baseline, ctx.config.checkpoint.maxFileSizeMb), "Next: write the goal in .relay/task.md"];
    ctx.io.out(all.map((line) => `${line}\n`).join(""));
    return ExitCode.Ok;
  } catch (error) {
    if (error instanceof RepositoryError) return fail(ctx, ExitCode.NotPossibleHere, error.lines);
    if (error instanceof CommandError) return fail(ctx, error.code, error.lines);
    throw error;
  }
}

function fail(ctx: CommandContext, code: number, lines: string[]): number {
  ctx.io.err(lines.map((line) => `${line}\n`).join(""));
  return code;
}

async function setUp(ctx: CommandContext): Promise<{ repo: Repository; jobId: string; lines: string[] }> {
  const repo = await openRepository(ctx.cwd);
  const relayDir = join(repo.worktreeRoot, ".relay");
  if (lstatSync(relayDir, { throwIfNoEntry: false }) !== undefined) throw alreadySetUp(relayDir);
  await checkGitleaks(ctx.env);
  const exclude = excludePath(repo);
  const title = jobTitle(ctx.values.title, repo);
  const jobId = await drawJobId(async (id) => existsSync(join(ctx.relayHome, "jobs", id)) || (await hasRefs(repo, id)));
  const jobDir = join(ctx.relayHome, "jobs", jobId);
  const job: JobRef = { id: jobId, worktreeRoot: repo.worktreeRoot, relayHome: ctx.relayHome };
  const createdAt = new Date().toISOString();
  const startedData = {
    title,
    worktree_root: repo.worktreeRoot,
    head: repo.head.sha,
    branch: repo.head.branch,
    detached: repo.head.detached,
    linked_worktree: repo.isLinkedWorktree,
  };
  // The title and the branch name come from the person or an agent, so what relay is about to
  // write is scanned for secrets first.
  await refuseSecrets(ctx, [
    { label: ".relay/task.md", text: taskTemplate(title, jobId) },
    { label: ".relay/state.json", text: stateText(newState(repo, jobId, title, createdAt)) },
    { label: ".relay/events.jsonl", text: JSON.stringify(startedData) },
  ]);

  try {
    mkdirSync(relayDir);
  } catch (error) {
    // Another relay init created the folder after the check above.
    if ((error as { code?: string }).code === "EEXIST") throw alreadySetUp(relayDir);
    throw error;
  }
  // Only what this command created is removed, on a failure or a signal, so the next relay init
  // can start again.
  const removeCreated = () => {
    for (const name of JOB_FILES) rmSync(join(relayDir, name), { force: true });
    rmSync(`${join(relayDir, "state.json")}.tmp`, { force: true });
    try {
      rmdirSync(relayDir);
    } catch {
      // Something else was put in the folder; it stays.
    }
    if (existsSync(jobDir)) rmSync(jobDir, { recursive: true, force: true });
  };
  const forget = onInterrupt(removeCreated);
  let added: boolean;
  try {
    writeTemplates(relayDir, jobId, title);
    createEventLog(job);
    added = addExcludeLine(exclude);
    try {
      await recordTrust(repo, jobDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CommandError(ExitCode.Failed, [
        printable(message.startsWith("relay ") ? message : `relay could not record the git settings of this job: ${message}`),
      ]);
    }
    await appendEvent(job, "job_started", startedData);
    // state.json comes last: a .relay folder without it is a set-up that did not finish.
    writeState(relayDir, newState(repo, jobId, title, createdAt));
  } catch (error) {
    removeCreated();
    throw error;
  } finally {
    forget();
  }

  const excludeShown = shownPath(exclude, repo.worktreeRoot, ctx.homedir);
  const lines = [
    `Set up relay in ${shownPath(repo.worktreeRoot, repo.worktreeRoot, ctx.homedir, true)}`,
    `Job ${jobId}`,
    `Wrote .relay/${JOB_FILES.join(", ")}`,
    added ? `Added /.relay/ to ${excludeShown}` : `/.relay/ is already in ${excludeShown}`,
  ];
  return { repo, jobId, lines };
}

async function refuseSecrets(ctx: CommandContext, parts: { label: string; text: string }[]): Promise<void> {
  const findings = await scanTexts(parts, { env: ctx.env });
  if (findings.length === 0) return;
  throw new CommandError(ExitCode.SecretFound, [
    ...findings.map((finding) => `Stopped: possible secret in ${printable(finding.label)} line ${finding.line} (${printable(finding.rule)}).`),
    "Nothing was set up. Remove the secret from the title or the branch name, then run relay init again.",
  ]);
}

function alreadySetUp(relayDir: string): CommandError {
  if (!lstatSync(relayDir).isDirectory()) {
    return new CommandError(ExitCode.NotPossibleHere, [
      `${printable(relayDir)} exists but is not a folder. Move it away, then run relay init again.`,
    ]);
  }
  let jobId: string;
  try {
    jobId = readState(relayDir).job_id;
  } catch (error) {
    if (!(error instanceof CommandError)) throw error;
    return new CommandError(ExitCode.NotPossibleHere, [
      `relay is already set up here, but ${lowerFirst(error.lines[0]!)}`,
      "If an earlier relay init was stopped before it finished, delete the .relay folder and run relay init again.",
    ]);
  }
  return new CommandError(ExitCode.NotPossibleHere, [`relay is already set up here (job ${jobId}).`]);
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

// The --title value, or else the branch name, or else the worktree folder name. Newlines become
// spaces, other control characters and invisible characters are removed, and the result is cut to
// 120 characters.
function jobTitle(value: string | boolean | string[] | undefined, repo: Repository): string {
  for (const candidate of [value, repo.head.branch, basename(repo.worktreeRoot)]) {
    if (typeof candidate !== "string") continue;
    const oneLine = candidate.replace(/\r\n|\r|\n/g, " ").replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
    const cleaned = removeInvisible(oneLine).text.trim();
    if (cleaned !== "") return Array.from(cleaned).slice(0, TITLE_LIMIT).join("");
  }
  return "job";
}

async function hasRefs(repo: Repository, jobId: string): Promise<boolean> {
  const result = await git(repo, ["for-each-ref", "--count=1", "--format=%(refname)", `refs/relay/jobs/${jobId}/`]);
  if (result.code !== 0) throw new Error(`relay could not list the refs of job ${jobId}: ${result.stderr.trim()}`);
  return result.stdout.length > 0;
}

function newState(repo: Repository, jobId: string, title: string, createdAt: string): JobState {
  return {
    schema_version: 1,
    job_id: jobId,
    title,
    status: "active",
    created_at: createdAt,
    updated_at: new Date().toISOString(),
    relay_version: VERSION,
    repository: { worktree_root: repo.worktreeRoot, common_git_dir: repo.commonDir, linked_worktree: repo.isLinkedWorktree },
    start: { head: repo.head.sha, branch: repo.head.branch, detached: repo.head.detached },
    latest_checkpoint: null,
    checkpoint_count: 0,
    approved_paths: [],
    last_rollback: null,
  };
}

// A path inside the worktree is shown relative to it, a path in the home folder starts with ~,
// and any other path is shown in full. `whole` shows the worktree root itself the same way.
function shownPath(path: string, worktreeRoot: string, home: string, whole = false): string {
  if (!whole && path.startsWith(worktreeRoot + sep)) return printable(relative(worktreeRoot, path));
  if (path === home || path.startsWith(home + sep)) return printable(`~${path.slice(home.length)}`);
  return printable(path);
}
