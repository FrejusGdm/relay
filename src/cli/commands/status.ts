// relay status [--job <id>] [--json] (design.md decision 20, the status-command spec). It asks the
// daemon with a 300 ms limit per request and never starts it. Without an answer it builds the
// same view from the files and says it shows saved state.
import { join } from "node:path";
import { getStatusSources, UntrustedRuntime } from "../../client/api-client";
import { reasonOf } from "../../core/log";
import { quote } from "../../core/quote";
import { runtimeDir } from "../../daemon/paths";
import { openRepository, RepositoryError } from "../../git/repo";
import { readState, StateFileError } from "../../job/state";
import { now } from "../../platform/clock";
import { readProjects, registerProject } from "../../state/projects-list";
import { buildView, type StatusData } from "../../status/model";
import { renderJson } from "../../status/render-json";
import { renderText } from "../../status/render-text";
import { fromFiles } from "../../status/sources";
import { CommandError } from "../errors";
import { ExitCode } from "../exit-codes";
import type { CommandContext } from "./registry";

const ANSWER_MS = 300;
const JOB_ID = /^[0-9a-f]{8}$/;
const NOT_IN_PROJECT = "This folder is not in a relay project. Run relay init here, or pass --job <id>.";

export async function status(ctx: CommandContext): Promise<number> {
  const asked = ctx.values.job;
  if (typeof asked === "string" && !JOB_ID.test(asked)) {
    ctx.io.err(`relay: --job needs a job ID of 8 hexadecimal characters, not ${quote(asked)}.\nRun "relay status --help" for an example.\n`);
    return ExitCode.Usage;
  }
  let found: { root: string; jobId: string };
  try {
    found = typeof asked === "string" ? findListedJob(ctx.relayHome, asked) : await findJobHere(ctx.cwd);
  } catch (error) {
    if (!(error instanceof CommandError)) throw error;
    ctx.io.err(error.lines.map((line) => `${line}\n`).join(""));
    return error.code;
  }
  try {
    registerProject(ctx.relayHome, found.root);
  } catch (error) {
    ctx.log.warn("project not registered", { reason: reasonOf(error) });
  }

  const data = await gather(ctx, found.root, found.jobId);
  if (data === null) {
    ctx.io.err(`The job files in ${quote(join(found.root, ".relay"))} could not be read.\n`);
    return ExitCode.NotPossibleHere;
  }
  const view = buildView(data);
  const time = now();
  const style = ctx.io.stdoutIsTTY && !ctx.env.NO_COLOR && ctx.env.TERM !== "dumb";
  ctx.io.out(ctx.values.json === true ? renderJson(view, time) : renderText(view, { now: time, style }));
  return ExitCode.Ok;
}

async function gather(ctx: CommandContext, root: string, jobId: string): Promise<StatusData | null> {
  let daemon: StatusData["daemon"] = "not_running";
  try {
    const answer = await getStatusSources(runtimeDir(ctx.env, ctx.relayHome), jobId, ANSWER_MS);
    if (answer !== null) {
      daemon = "running";
      if (answer.job !== null) return { job: answer.job, workers: answer.workers, accounts: answer.accounts, daemon };
    }
  } catch (error) {
    if (!(error instanceof UntrustedRuntime)) throw error;
    ctx.io.err(`${error.message}\n`);
  }
  // The daemon did not answer, or has not indexed this project yet.
  const saved = await fromFiles(ctx.relayHome, root, jobId, ctx.config.accounts);
  return saved === null ? null : { ...saved, daemon };
}

// The job of the relay project that holds the current folder.
async function findJobHere(cwd: string): Promise<{ root: string; jobId: string }> {
  let root: string;
  try {
    root = (await openRepository(cwd)).worktreeRoot;
  } catch (error) {
    if (error instanceof RepositoryError) throw new CommandError(ExitCode.NotPossibleHere, [NOT_IN_PROJECT]);
    throw error;
  }
  try {
    return { root, jobId: readState(join(root, ".relay")).job_id };
  } catch (error) {
    if (error instanceof StateFileError && error.problem === null) throw new CommandError(ExitCode.NotPossibleHere, [NOT_IN_PROJECT]);
    throw error;
  }
}

// The listed project whose state.json has this job ID.
function findListedJob(relayHome: string, jobId: string): { root: string; jobId: string } {
  for (const root of readProjects(relayHome)) {
    try {
      if (readState(join(root, ".relay")).job_id === jobId) return { root, jobId };
    } catch {
      // A moved or damaged project is not this job.
    }
  }
  throw new CommandError(ExitCode.NotPossibleHere, [`No job with id ${jobId} is in a project relay knows. Run relay status inside the project.`]);
}
