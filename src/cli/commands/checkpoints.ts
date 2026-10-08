// relay checkpoints (the checkpoints spec, "Listing checkpoints"): lists the job's checkpoints,
// newest first, as aligned text or as JSON. It only reads, so it takes no lock and appends no event.
import { listCheckpoints, type CheckpointInfo } from "../../checkpoint/list";
import { openJob } from "../../checkpoint/save";
import { printable } from "../../core/quote";
import { openRepository, RepositoryError } from "../../git/repo";
import { CommandError } from "../errors";
import { ExitCode } from "../exit-codes";
import { timeAgo } from "../output";
import type { CommandContext } from "./registry";

const KIND_LABELS: Record<string, string> = {
  baseline: "baseline",
  manual: "manual",
  pre_rollback: "before rollback",
  handoff: "handoff",
  auto: "auto",
};

export async function checkpoints(ctx: CommandContext): Promise<number> {
  try {
    const repo = await openRepository(ctx.cwd);
    const { state, job } = await openJob(repo, ctx.relayHome, null);
    const list = await listCheckpoints(repo, job.id);
    const text =
      ctx.values.json === true
        ? `${JSON.stringify(list.map(jsonCheckpoint))}\n`
        : listLines(job.id, state.title, list, new Date()).map((line) => `${line}\n`).join("");
    ctx.io.out(text);
    return ExitCode.Ok;
  } catch (error) {
    if (error instanceof RepositoryError || error instanceof CommandError) {
      ctx.io.err(error.lines.map((line) => `${line}\n`).join(""));
      return error instanceof RepositoryError ? ExitCode.NotPossibleHere : error.code;
    }
    throw error;
  }
}

// A header line, an empty line and one row per checkpoint, with the columns aligned.
export function listLines(jobId: string, title: string, list: CheckpointInfo[], now: Date): string[] {
  const header = [`Job ${jobId} · ${printable(title)}`, ""];
  if (list.length === 0) return [...header, "No checkpoints yet. Save one with relay checkpoint."];
  const rows = list.map((checkpoint) => [
    String(checkpoint.number),
    checkpoint.commit.slice(0, 7),
    kindLabel(checkpoint.kind),
    timeAgo(checkpoint.createdAt, now),
    checkpoint.message === null ? "" : printable(checkpoint.message),
  ]);
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  const pad = (row: string[]) =>
    row.map((cell, column) => (column === 0 ? cell.padStart(widths[0]!) : cell.padEnd(widths[column]!))).join("  ").trimEnd();
  return [...header, ...rows.map(pad)];
}

// How the list shows a kind; relay rollback uses it for the undo checkpoint.
export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? printable(kind);
}

function jsonCheckpoint(checkpoint: CheckpointInfo): Record<string, unknown> {
  return {
    number: checkpoint.number,
    commit: checkpoint.commit,
    ref: checkpoint.ref,
    kind: checkpoint.kind,
    message: checkpoint.message,
    created_at: checkpoint.createdAt.toISOString(),
    head: checkpoint.head,
    left_out: checkpoint.leftOut,
  };
}
