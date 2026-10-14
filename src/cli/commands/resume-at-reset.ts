// relay resume-at-reset off [--job <id> | --thread <id>] (add-resume-at-reset, the resume-at-reset
// and t3-resume-at-reset specs): cancels a job's wait for its usage limit to reset, or a T3 Code
// thread's. A wait is turned on by relay run --resume-at-reset, or for T3 threads by
// [t3.resume_at_reset] in config.toml.
import { quote } from "../../core/quote";
import { isJobId } from "../../job/id";
import { cancelWait } from "../../resume/follow";
import { findJobContext } from "../../run/job-context";
import { cancelT3Wait, isT3ThreadId } from "../../t3/resume-state";
import { CommandError } from "../errors";
import { ExitCode } from "../exit-codes";
import type { CommandContext } from "./registry";

export async function resumeAtReset(ctx: CommandContext): Promise<number> {
  const err = (line: string) => ctx.io.err(`${line}\n`);
  if (ctx.positionals[0] !== "off") {
    err(`relay: resume-at-reset takes off, not ${quote(ctx.positionals[0] ?? "")}.`);
    err('Run "relay resume-at-reset --help" for an example.');
    return ExitCode.Usage;
  }
  const job = ctx.values.job as string | undefined;
  const thread = ctx.values.thread as string | undefined;
  if (job !== undefined && thread !== undefined) {
    err("relay: give --job or --thread, not both.");
    return ExitCode.Usage;
  }
  if (thread !== undefined) {
    if (!isT3ThreadId(thread)) {
      err(`relay: ${quote(thread)} is not a T3 thread ID.`);
      return ExitCode.Usage;
    }
    if (!(await cancelT3Wait(ctx.relayHome, thread))) {
      err(`T3 thread ${thread} has no resume at reset to cancel.`);
      return ExitCode.Failed;
    }
    ctx.io.out(`Cancelled resume at reset for T3 thread ${thread}.\n`);
    return ExitCode.Ok;
  }
  if (job !== undefined && !isJobId(job)) {
    err(`relay: --job needs a job ID of 8 hexadecimal characters, not ${quote(job)}.`);
    return ExitCode.Usage;
  }
  let jobId: string;
  try {
    jobId = job ?? (await findJobContext(ctx.cwd, ctx.relayHome)).job.id;
  } catch (error) {
    if (!(error instanceof CommandError)) throw error;
    err("This folder is not in a relay job. Run the command inside the job's project, or pass --job <id>.");
    return error.code;
  }
  const state = await cancelWait(ctx.relayHome, jobId);
  if (state === null) {
    err(`Job ${jobId} has no resume at reset to cancel.`);
    return ExitCode.Failed;
  }
  ctx.io.out(`Cancelled resume at reset for job ${jobId}.\n`);
  if (state === "resuming") ctx.io.out("The agent relay already resumed finishes its turn; relay does not resume this job again.\n");
  return ExitCode.Ok;
}
