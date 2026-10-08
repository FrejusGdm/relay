// relay daemon <start|stop|restart|status|run> (design.md decision 7, the daemon-lifecycle spec).
// Whether a daemon runs is decided by its lock: a held daemon.lock means a daemon process is alive.
// stop signals only the process that daemon.pid and the daemon's own answer name and, on Linux,
// that holds the lock. Without --force, stop refuses while the daemon runs agents it started.
import { join } from "node:path";
import { checkRuntimeDir, getVersion, UntrustedRuntime } from "../../client/api-client";
import { couldNotStartMessage, startDaemon } from "../../client/ensure-daemon";
import { printable, quote } from "../../core/quote";
import { runtimeDir, socketPath } from "../../daemon/paths";
import { daemonLockHolder, pidPath, readPidFile } from "../../daemon/singleton";
import { processExists } from "../../state/queries";
import { ExitCode } from "../exit-codes";
import type { CommandContext } from "./registry";

const ANSWER_MS = 1000;
const STOP_WAIT_MS = 40_000;
const STOP_POLL_MS = 100;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export async function daemon(ctx: CommandContext): Promise<number> {
  try {
    return await runAction(ctx);
  } catch (error) {
    if (!(error instanceof UntrustedRuntime)) throw error;
    ctx.io.err(`${error.message}\n`);
    return ExitCode.Failed;
  }
}

async function runAction(ctx: CommandContext): Promise<number> {
  const action = ctx.positionals[0]!;
  switch (action) {
    case "run": {
      // Loaded only here, so other commands never load the listener.
      const { runDaemon } = await import("../../daemon/main");
      return runDaemon({
        relayHome: ctx.relayHome,
        env: ctx.env,
        logLevel: ctx.logLevel,
        config: ctx.config,
        homedir: ctx.homedir,
        err: ctx.io.err,
      });
    }
    case "start":
      return start(ctx);
    case "stop":
      return stopDaemon(ctx);
    case "restart": {
      const code = await stopDaemon(ctx);
      return code === ExitCode.Ok ? start(ctx) : code;
    }
    case "status":
      return status(ctx);
    default:
      ctx.io.err(
        `relay: daemon needs start, stop, restart, status or run, not ${quote(action)}.\n` +
          'Run "relay daemon --help" for an example.\n',
      );
      return ExitCode.Usage;
  }
}

async function start(ctx: CommandContext): Promise<number> {
  const result = await startDaemon({ relayHome: ctx.relayHome, env: ctx.env, err: ctx.io.err });
  switch (result.state) {
    case "running":
      ctx.io.out(`relay daemon is already running (pid ${result.pid})\n`);
      return ExitCode.Ok;
    case "started":
      ctx.io.out(`relay daemon started (pid ${result.pid})\n`);
      return ExitCode.Ok;
    case "not_responding":
      return notResponding(ctx, runtimeDir(ctx.env, ctx.relayHome));
    case "failed":
      return couldNotStart(ctx);
  }
}

// relay daemon stop. With quiet, only problems are printed (relay doctor --reindex uses it).
export async function stopDaemon(ctx: CommandContext, quiet = false): Promise<number> {
  const out = (text: string) => {
    if (!quiet) ctx.io.out(text);
  };
  const runDir = runtimeDir(ctx.env, ctx.relayHome);
  checkRuntimeDir(runDir);
  if (daemonLockHolder(runDir) === null) {
    out("relay daemon is not running\n");
    return ExitCode.Ok;
  }
  const answer = await getVersion(runDir, ANSWER_MS);
  const file = readPidFile(runDir);
  if (answer === null) return notResponding(ctx, runDir);
  if (file === null || file.pid !== answer.pid) {
    ctx.io.err("relay found a pid file that does not match the running daemon. Run relay daemon status.\n");
    return ExitCode.Failed;
  }
  const agents = answer.agents_running;
  if (agents.length > 0 && ctx.values.force !== true) {
    const list = agents.map((agent) => `${printable(agent.target)} on job ${printable(agent.job)}`).join(", ");
    ctx.io.err(
      `relay daemon is running ${agents.length} ${agents.length === 1 ? "agent" : "agents"} (${list}). ` +
        `Stopping the daemon stops ${agents.length === 1 ? "it" : "them"} too. Run relay daemon stop --force to continue.\n`,
    );
    return ExitCode.Failed;
  }
  // The lock is checked again just before the signal. On Linux relay also checks that the process
  // holding it is the one that answered. On macOS relay cannot name the holder, so a race remains:
  // if the daemon exits and its process ID is reused between this check and the signal, a few
  // microseconds, the signal reaches the new process.
  const holder = daemonLockHolder(runDir);
  if (holder === null) {
    out("relay daemon stopped\n");
    return ExitCode.Ok;
  }
  if (holder.pid !== null && holder.pid !== answer.pid) {
    ctx.io.err(
      `relay found that pid ${holder.pid} holds the daemon lock, not the daemon that answered (pid ${answer.pid}). relay sent no signal.\n`,
    );
    return ExitCode.Failed;
  }
  try {
    process.kill(answer.pid, "SIGTERM");
  } catch (error) {
    if ((error as { code?: string }).code !== "ESRCH") throw error;
  }
  // Done when the daemon's process is gone. The daemon frees its lock a moment before it exits, and
  // a daemon started meanwhile by another command may hold the lock again, so the lock alone does
  // not say the process ended.
  const deadline = Date.now() + STOP_WAIT_MS;
  while (Date.now() < deadline) {
    if (!processExists(answer.pid)) {
      out("relay daemon stopped\n");
      return ExitCode.Ok;
    }
    await Bun.sleep(STOP_POLL_MS);
  }
  ctx.io.err(
    `relay daemon (pid ${answer.pid}) did not stop within 40 seconds. It is still finishing work; see ${printable(logPath(ctx))}.\n`,
  );
  return ExitCode.Failed;
}

async function status(ctx: CommandContext): Promise<number> {
  const runDir = runtimeDir(ctx.env, ctx.relayHome);
  checkRuntimeDir(runDir);
  if (daemonLockHolder(runDir) === null) {
    ctx.io.out("relay daemon is not running\n");
    return ExitCode.DaemonNotRunning;
  }
  const answer = await getVersion(runDir, ANSWER_MS);
  if (answer === null) return notResponding(ctx, runDir);
  const home = (path: string) => printable(shortPath(path, ctx.homedir));
  ctx.io.out(
    `Running   pid ${answer.pid} · version ${printable(answer.daemon_version)} · started ${startedAt(answer.started_at)}\n` +
      `Socket    ${home(socketPath(runDir))}\n` +
      `Log       ${home(logPath(ctx))}\n`,
  );
  return ExitCode.Ok;
}

// A daemon holds the lock but does not answer: relay sends no signal and says how to stop it.
function notResponding(ctx: CommandContext, runDir: string): number {
  const pid = readPidFile(runDir)?.pid;
  ctx.io.err(
    pid === undefined
      ? `relay daemon is not responding, and relay cannot read ${printable(pidPath(runDir))}.\n`
      : `relay daemon (pid ${pid}) is not responding. Stop it with: kill ${pid}\n`,
  );
  return ExitCode.Failed;
}

export function couldNotStart(ctx: CommandContext): number {
  ctx.io.err(couldNotStartMessage(ctx.relayHome, ctx.env));
  return ExitCode.DaemonNotRunning;
}

function logPath(ctx: CommandContext): string {
  return join(ctx.relayHome, "logs", "daemon.log");
}

function shortPath(path: string, homedir: string): string {
  return path.startsWith(`${homedir}/`) ? `~${path.slice(homedir.length)}` : path;
}

// "14:02" on the same day, otherwise "Oct 12 14:02", in local time.
function startedAt(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return printable(iso);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return date.toDateString() === now.toDateString() ? time : `${MONTHS[date.getMonth()]} ${date.getDate()} ${time}`;
}
