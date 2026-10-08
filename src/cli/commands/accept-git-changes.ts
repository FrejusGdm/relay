// relay accept-git-changes (the git-safety spec, design.md decision 11): the person, at a terminal,
// trusts the git configuration and hooks as they are now. relay shows what changed since the
// trust record and rewrites the record only after the answer yes, and only when nothing changed
// while it waited. A missing or damaged record can be rewritten the same way.
import { join } from "node:path";
import { findJob } from "../../checkpoint/save";
import { onInterrupt } from "../../core/cleanup";
import { openRepository, RepositoryError } from "../../git/repo";
import { changedFiles, reviewTrust, trustReport } from "../../git/trust";
import { appendEvent } from "../../job/events";
import { takeJobLock } from "../../job/lock";
import { CommandError } from "../errors";
import { ExitCode } from "../exit-codes";
import type { CommandContext } from "./registry";

export async function acceptGitChanges(ctx: CommandContext): Promise<number> {
  // An agent runs commands without a terminal. Checked first, so nothing else runs for it.
  if (!ctx.io.isTerminal) {
    ctx.io.err(text(["relay accept-git-changes must be run by you in a terminal."]));
    return ExitCode.NeedsPerson;
  }
  try {
    const repo = await openRepository(ctx.cwd);
    const { job } = findJob(repo, ctx.relayHome);
    const release = takeJobLock(ctx.relayHome, job.id, "accept-git-changes");
    const forget = onInterrupt(release);
    try {
      const review = await reviewTrust(repo, join(ctx.relayHome, "jobs", job.id));
      if (review.problem === null && review.changes.length === 0) {
        ctx.io.out(text(["Nothing changed in the git configuration or hooks."]));
        return ExitCode.Ok;
      }
      ctx.io.out(text(review.lines));
      ctx.io.out(review.problem === null
        ? "Trust these changes? Type yes to continue: "
        : "Trust the current git configuration and hooks? Type yes to continue: ");
      if ((await ctx.io.readLine())?.trim() !== "yes") {
        ctx.io.err(text(["Cancelled. Nothing changed."]));
        return ExitCode.NeedsPerson;
      }
      if (!(await review.accept())) {
        ctx.io.err(text([
          "The git settings or hooks changed while relay was waiting. Nothing was trusted. Run relay accept-git-changes again.",
        ]));
        return ExitCode.NeedsPerson;
      }
      await appendEvent(job, "git_changes_accepted", {
        changed: changedFiles(review.changes),
        ...(review.problem === null ? {} : { trust_record: review.problem.problem }),
      });
      ctx.io.out(text(["Trusted the current git configuration and hooks."]));
      return ExitCode.Ok;
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

function text(lines: string[]): string {
  return lines.map((line) => `${line}\n`).join("");
}
