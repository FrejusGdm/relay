// The engines' errors as answers of the local API (design.md decisions 13 and 17). The engines stop
// with the same CommandErrors that the command-line tool turns into exit codes; this file turns
// them into the rows of the error table.
import { CommandError, SettingsError } from "../cli/errors";
import { ExitCode } from "../cli/exit-codes";
import { OperationRefused } from "../daemon/operations";
import { PersonNeeded } from "../handoff/ask";
import { errorResponse } from "./errors";

// The job's folder is gone, is no longer a repository, or holds another job.
export class ProjectMissing extends Error {
  constructor(jobId: string, root: string) {
    super(`The project for job ${jobId} is not at ${root} any more.`);
    this.name = "ProjectMissing";
  }
}

export class TargetNotFound extends Error {
  constructor(target: string) {
    super(`No account named ${target} in config.toml.`);
    this.name = "TargetNotFound";
  }
}

// The answer for an error of a checkpoint or switch request. `target` is the account a switch asked
// for. Errors that are not the engines' own are thrown again; the server answers them with
// internal_error.
export function engineErrorResponse(error: unknown, target: string | null = null): Response {
  if (error instanceof OperationRefused) {
    return error.reason === "busy"
      ? errorResponse(409, "operation_in_progress", error.message)
      : errorResponse(503, "shutting_down", error.message);
  }
  if (error instanceof ProjectMissing) return errorResponse(409, "project_missing", error.message);
  if (error instanceof TargetNotFound) return errorResponse(404, "target_not_found", error.message);
  if (error instanceof PersonNeeded && error.question !== null) {
    return errorResponse(409, "confirmation_required", error.question.replace(/ \[y\/N\]$/, ""));
  }
  if (error instanceof SettingsError) return errorResponse(500, "engine_failed", message(error.lines));
  if (!(error instanceof CommandError)) throw error;
  if (error instanceof PersonNeeded || error.code === ExitCode.NeedsPerson) {
    return errorResponse(409, "interactive_start_required", `This switch needs a terminal. Run relay switch ${target} in the project.`);
  }
  switch (error.code) {
    case ExitCode.SecretFound:
      // The checkpoint engine stops with the same exit code for a secret it found in a file and
      // for an untracked file whose name looks like it holds secrets.
      return error.lines[0]?.includes("is not ignored by git")
        ? errorResponse(422, "untracked_secret_file", message(error.lines))
        : errorResponse(422, "secret_found", message(error.lines));
    case ExitCode.GitChanged:
      return errorResponse(409, "git_changes_not_accepted", message(error.lines));
    case ExitCode.Busy:
      return errorResponse(409, "operation_in_progress", message(error.lines));
    case ExitCode.Usage:
      return errorResponse(400, "bad_request", message(error.lines));
    default:
      return errorResponse(500, "engine_failed", message(error.lines));
  }
}

// The engine's lines as one text, without the "relay: " that starts some of them in a terminal.
function message(lines: string[]): string {
  return lines.map((line) => line.replace(/^relay: /, "")).join(" ");
}
