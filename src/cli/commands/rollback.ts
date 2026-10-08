// relay rollback [<checkpoint>] [--yes] [--dry-run] (the rollback spec, design.md decision 9). The
// job lock is held from the start, so no other relay command saves a checkpoint or rolls back
// while the person reads the plan.
import { join } from "node:path";
import { listCheckpoints } from "../../checkpoint/list";
import {
  applyPlan, checkResult, filesInTheWay, prepareRollback, recordRollback, resolveTarget, sameFiles, saveUndoPoint,
  type Prepared, type RollbackSettings,
} from "../../checkpoint/rollback";
import { openJob } from "../../checkpoint/save";
import { onInterrupt, wasInterrupted } from "../../core/cleanup";
import { printable, quote } from "../../core/quote";
import { openRepository, RepositoryError, type Repository } from "../../git/repo";
import type { JobRef } from "../../job/events";
import { takeJobLock } from "../../job/lock";
import { readState } from "../../job/state";
import { CommandError } from "../errors";
import { ExitCode } from "../exit-codes";
import { timeAgo } from "../output";
import { kindLabel } from "./checkpoints";
import type { CommandContext } from "./registry";

export async function rollback(ctx: CommandContext): Promise<number> {
  try {
    const repo = await openRepository(ctx.cwd);
    const { job } = await openJob(repo, ctx.relayHome, "rollback");
    const release = takeJobLock(ctx.relayHome, job.id, "rollback");
    const forget = onInterrupt(release);
    try {
      return await rollBack(ctx, repo, job);
    } finally {
      forget();
      release();
    }
  } catch (error) {
    if (error instanceof RepositoryError || error instanceof CommandError) {
      ctx.io.err(text(error.lines));
      return error instanceof RepositoryError ? ExitCode.NotPossibleHere : error.code;
    }
    throw error;
  }
}

async function rollBack(ctx: CommandContext, repo: Repository, job: JobRef): Promise<number> {
  // Read again under the lock, so the approved paths are current.
  const state = readState(join(repo.worktreeRoot, ".relay"));
  const settings: RollbackSettings = {
    job,
    maxFileSizeMb: ctx.config.checkpoint.maxFileSizeMb,
    approved: state.approved_paths,
    env: ctx.env,
  };
  const target = resolveTarget(await listCheckpoints(repo, job.id), ctx.positionals[0]);
  const prepared = await prepareRollback(repo, settings, target);
  refuseUnsaved(repo, prepared);
  if (prepared.plan.entries.length === 0) {
    ctx.io.out(text([`Nothing to roll back. Your files already match checkpoint ${target.number}.`]));
    return ExitCode.Ok;
  }

  ctx.io.out(text(planLines(prepared, new Date())));
  if (ctx.values["dry-run"] === true) return ExitCode.Ok;
  if (ctx.values.yes === true) {
    ctx.io.out("\n");
  } else {
    if (!ctx.io.isTerminal) {
      ctx.io.err(text(["Run again with --yes to roll back."]));
      return ExitCode.NeedsPerson;
    }
    ctx.io.out("Roll back? [y/N] ");
    const answer = (await ctx.io.readLine())?.trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      ctx.io.err(text(["Cancelled. Nothing changed."]));
      return ExitCode.NeedsPerson;
    }
  }

  let undo;
  try {
    undo = await saveUndoPoint(repo, settings, target);
  } catch (error) {
    if (!(error instanceof CommandError)) throw error;
    throw new CommandError(error.code, ["relay could not save your current files before rolling back, so it changed nothing.", ...error.lines]);
  }
  const undoNumber = undo.saved ? undo.number : undo.latest;
  if (undo.saved) ctx.io.out(text([`Saved checkpoint ${undo.number} · ${undo.commit.slice(0, 7)} (${kindLabel(undo.kind)})`]));
  if (!(await sameFiles(repo, prepared, undo))) {
    ctx.io.err(text(["Your files changed while relay was waiting, so it changed nothing.", "Run relay rollback again to see what will change."]));
    return ExitCode.NeedsPerson;
  }
  // Checked again just before the first file changes.
  refuseUnsaved(repo, prepared);

  const undoLine = `To undo: relay rollback ${undoNumber}`;
  const forget = onInterrupt(() => ctx.io.err(text(["relay was stopped before the rollback finished.", undoLine])));
  try {
    await applyPlan(repo, job, prepared);
    // A signal stopped git; main.ts prints the undo command and exits.
    if (wasInterrupted()) return ExitCode.Interrupted;
    const differing = await checkResult(repo, settings, prepared);
    await recordRollback(job, prepared, undoNumber);
    if (differing.length > 0) {
      ctx.io.err(text([
        `Rollback finished, but these files do not match checkpoint ${target.number}: ${differing.map(printable).join(", ")}`,
        undoLine,
      ]));
      return ExitCode.Failed;
    }
  } catch (error) {
    if (error instanceof CommandError) throw new CommandError(error.code, [...error.lines, undoLine]);
    if (error instanceof Error) throw new CommandError(ExitCode.Failed, [...error.message.split("\n").map(printable), undoLine]);
    throw error;
  } finally {
    forget();
  }

  const count = prepared.plan.entries.length;
  const branchMoved = repo.head.branch !== null && repo.head.sha !== null && repo.head.sha !== target.head;
  ctx.io.out(text([
    `Rolled back to checkpoint ${target.number} · ${target.commit.slice(0, 7)}`,
    `${count} ${count === 1 ? "file" : "files"} changed`,
    ...(branchMoved ? [`Your branch still points to ${repo.head.sha!.slice(0, 7)}. The restored files show as uncommitted changes.`] : []),
    undoLine,
  ]));
  return ExitCode.Ok;
}

// Stops with exit code 8 when the plan would write or delete a file relay has not saved.
function refuseUnsaved(repo: Repository, prepared: Prepared): void {
  const paths = filesInTheWay(repo.worktreeRoot, prepared.plan, prepared.unsaved);
  if (paths.length === 0) return;
  throw new CommandError(ExitCode.UnsavedFiles, [
    `Rolling back would overwrite files relay has not saved: ${paths.map(printable).join(", ")}. Move them or delete them yourself, then try again.`,
  ]);
}

function planLines(prepared: Prepared, now: Date): string[] {
  const { target, plan } = prepared;
  const when = timeAgo(target.createdAt, now);
  const count = plan.entries.length;
  return [
    `Roll back to checkpoint ${target.number} · ${target.commit.slice(0, 7)} (${target.message === null ? when : `${when}, ${quote(target.message)}`})`,
    "",
    ...plan.entries.map((entry) => `  ${entry.action.padEnd(6)}  ${printable(entry.path)}`),
    "",
    `${count} ${count === 1 ? "file will" : "files will"} change. Your branch, commits and staged changes stay as they are.`,
    "relay saves your current files as a checkpoint first, so you can undo this.",
  ];
}

function text(lines: string[]): string {
  return lines.map((line) => `${line}\n`).join("");
}
