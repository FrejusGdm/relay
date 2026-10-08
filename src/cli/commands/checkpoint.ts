// relay checkpoint (the checkpoints spec): saves the job's working tree as a checkpoint through
// saveCheckpoint and prints the result as text or JSON.
import { posix } from "node:path";
import { saveCheckpoint, type SaveResult } from "../../checkpoint/save";
import { printable, quote } from "../../core/quote";
import { openRepository, RepositoryError } from "../../git/repo";
import { CommandError } from "../errors";
import { ExitCode } from "../exit-codes";
import type { CommandContext } from "./registry";

export async function checkpoint(ctx: CommandContext): Promise<number> {
  try {
    const include = includePaths(ctx.values.include);
    const repo = await openRepository(ctx.cwd);
    const message = ctx.values.message;
    const result = await saveCheckpoint(repo, {
      relayHome: ctx.relayHome,
      command: "checkpoint",
      kind: "manual",
      maxFileSizeMb: ctx.config.checkpoint.maxFileSizeMb,
      env: ctx.env,
      message: typeof message === "string" ? message : undefined,
      include,
    });
    const lines = ctx.values.json === true ? [JSON.stringify(jsonResult(result))] : savedLines(result, ctx.config.checkpoint.maxFileSizeMb);
    ctx.io.out(lines.map((line) => `${line}\n`).join(""));
    return ExitCode.Ok;
  } catch (error) {
    if (error instanceof RepositoryError || error instanceof CommandError) {
      const code = error instanceof RepositoryError ? ExitCode.NotPossibleHere : error.code;
      ctx.io.err(error.lines.map((line) => `${line}\n`).join(""));
      return code;
    }
    throw error;
  }
}

function savedLines(result: SaveResult, limitMb: number): string[] {
  if (!result.saved) return [`Nothing changed since checkpoint ${result.latest}.`, ...fileLines(result, limitMb)];
  const files = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const second =
    result.compared.with === "checkpoint"
      ? `${files(result.filesChanged, "file changed", "files changed")} since checkpoint ${result.compared.number}`
      : result.compared.with === "commit"
        ? `${files(result.filesChanged, "file differs", "files differ")} from commit ${result.compared.commit.slice(0, 7)}`
        : files(result.filesChanged, "file saved", "files saved");
  return [`Saved checkpoint ${result.number} · ${result.commit.slice(0, 7)}`, second, ...fileLines(result, limitMb)];
}

// A line for each left-out file and each approved file saved for the first time.
export function fileLines(result: SaveResult, limitMb: number): string[] {
  return [
    ...result.leftOut.map((file) =>
      file.reason === "size"
        ? `Left out ${printable(file.path)} (${megabytes(file.bytes)} MB, over the ${limitMb} MB limit)`
        : `Left out ${printable(file.path)} (a separate git repository)`,
    ),
    ...(result.saved ? result.included.map((path) => `Included ${printable(path)} (you approved it)`) : []),
  ];
}

function jsonResult(result: SaveResult): Record<string, unknown> {
  if (!result.saved) {
    // The spec's exact object when nothing was left out.
    const leftOut = result.leftOut.map((file) => file.path);
    return leftOut.length === 0 ? { saved: false, latest: result.latest } : { saved: false, latest: result.latest, left_out: leftOut };
  }
  return {
    saved: true,
    number: result.number,
    commit: result.commit,
    ref: result.ref,
    files_changed: result.filesChanged,
    left_out: result.leftOut.map((file) => file.path),
  };
}

// One decimal under 10 MB, whole megabytes above.
function megabytes(bytes: number): string {
  const value = bytes / (1024 * 1024);
  return value < 10 ? String(Math.round(value * 10) / 10) : String(Math.round(value));
}

// --include paths are relative to the worktree root and must stay inside it.
function includePaths(value: string | boolean | string[] | undefined): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return values.map((path) => {
    const normal = posix.normalize(path).replace(/^\.\//, "").replace(/\/$/, "");
    if (path === "" || posix.isAbsolute(normal) || normal === "." || normal === ".." || normal.startsWith("../")) {
      throw new CommandError(ExitCode.Usage, [
        `relay: --include needs a path relative to the top folder of the project, not ${quote(path)}.`,
      ]);
    }
    return normal;
  });
}
