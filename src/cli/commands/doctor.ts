// relay doctor --reindex (design.md decision 11, the live-state-index spec, "Forced rebuild"):
// stops the daemon, deletes relay.db and its write-ahead log files, and starts the daemon, which
// rebuilds the index from the .relay/ files and git.
import { rmSync } from "node:fs";
import { getJobRoots, UntrustedRuntime } from "../../client/api-client";
import { startDaemon } from "../../client/ensure-daemon";
import { runtimeDir } from "../../daemon/paths";
import { databasePath } from "../../state/db";
import { ExitCode } from "../exit-codes";
import { couldNotStart, stopDaemon } from "./daemon";
import type { CommandContext } from "./registry";

const ANSWER_MS = 5000;

export async function doctor(ctx: CommandContext): Promise<number> {
  if (ctx.values.reindex !== true) {
    ctx.io.err('relay: doctor needs --reindex.\nRun "relay doctor --help" for an example.\n');
    return ExitCode.Usage;
  }
  try {
    return await reindex(ctx);
  } catch (error) {
    if (!(error instanceof UntrustedRuntime)) throw error;
    ctx.io.err(`${error.message}\n`);
    return ExitCode.Failed;
  }
}

async function reindex(ctx: CommandContext): Promise<number> {
  const stopped = await stopDaemon(ctx, true);
  if (stopped !== ExitCode.Ok) return stopped;
  const database = databasePath(ctx.relayHome);
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${database}${suffix}`, { force: true });

  const started = await startDaemon({ relayHome: ctx.relayHome, env: ctx.env, err: ctx.io.err });
  if (started.state !== "running" && started.state !== "started") return couldNotStart(ctx);
  const roots = await getJobRoots(runtimeDir(ctx.env, ctx.relayHome), ANSWER_MS);
  if (roots === null) return couldNotStart(ctx);
  ctx.io.out(`Rebuilt the index from .relay/ files in ${new Set(roots).size} projects.\n`);
  return ExitCode.Ok;
}
