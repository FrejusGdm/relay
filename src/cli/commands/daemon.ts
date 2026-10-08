// relay daemon <start|stop|restart|status|run> (design.md decision 7, the daemon-lifecycle spec).
// Whether a daemon runs is decided by its lock: a held daemon.lock means a daemon process is alive.
// stop signals only the process that both daemon.pid and the daemon's own answer name.
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { getVersion } from "../../client/api-client";
import { startDaemon } from "../../client/ensure-daemon";
import { printable, quote } from "../../core/quote";
import { runtimeDir, runtimeDirIsPrivate, socketPath } from "../../daemon/paths";
import { pidPath, readPidFile, takeDaemonLock } from "../../daemon/singleton";
import { ExitCode } from "../exit-codes";
import type { CommandContext } from "./registry";

const ANSWER_MS = 1000;
const STOP_WAIT_MS = 40_000;
const STOP_POLL_MS = 100;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export async function daemon(ctx: CommandContext): Promise<number> {
  const action = ctx.positionals[0]!;
  switch (action) {
    case "run": {
      // Loaded only here, so other commands never load the listener.
      const { runDaemon } = await import("../../daemon/main");
      return runDaemon({ relayHome: ctx.relayHome, env: ctx.env, logLevel: ctx.logLevel, err: ctx.io.err });
    }
    case "start":
      return start(ctx);
    case "stop":
      return stop(ctx);
    case "restart": {
      const code = await stop(ctx);
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
    case "failed":
      ctx.io.err(`relay could not start its background service. Details are in ${printable(logPath(ctx))}.\n`);
      return ExitCode.DaemonNotRunning;
  }
}

async function stop(ctx: CommandContext): Promise<number> {
  const runDir = runtimeDir(ctx.env, ctx.relayHome);
  if (!runtimeDirIsPrivate(runDir)) return notPrivate(ctx, runDir);
  if (!daemonAlive(runDir)) {
    ctx.io.out("relay daemon is not running\n");
    return ExitCode.Ok;
  }
  const answer = await getVersion(socketPath(runDir), ANSWER_MS);
  const file = readPidFile(runDir);
  if (answer === null) return notResponding(ctx, runDir);
  if (file === null || file.pid !== answer.pid) {
    ctx.io.err("relay found a pid file that does not match the running daemon. Run relay daemon status.\n");
    return ExitCode.Failed;
  }
  // The lock is checked again just before the signal, so a daemon that exited after it answered
  // leaves no time for its process ID to be reused.
  if (!daemonAlive(runDir)) {
    ctx.io.out("relay daemon stopped\n");
    return ExitCode.Ok;
  }
  try {
    process.kill(answer.pid, "SIGTERM");
  } catch (error) {
    if ((error as { code?: string }).code !== "ESRCH") throw error;
  }
  // Done when the daemon's process is gone or the lock is free; a daemon started meanwhile by
  // another command may hold the lock again.
  const deadline = Date.now() + STOP_WAIT_MS;
  while (Date.now() < deadline) {
    if (!processExists(answer.pid) || !daemonAlive(runDir)) {
      ctx.io.out("relay daemon stopped\n");
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
  if (!runtimeDirIsPrivate(runDir)) return notPrivate(ctx, runDir);
  if (!daemonAlive(runDir)) {
    ctx.io.out("relay daemon is not running\n");
    return ExitCode.DaemonNotRunning;
  }
  const answer = await getVersion(socketPath(runDir), ANSWER_MS);
  if (answer === null) return notResponding(ctx, runDir);
  const home = (path: string) => printable(shortPath(path, ctx.homedir));
  ctx.io.out(
    `Running   pid ${answer.pid} · version ${printable(answer.daemon_version)} · started ${startedAt(answer.started_at)}\n` +
      `Socket    ${home(socketPath(runDir))}\n` +
      `Log       ${home(logPath(ctx))}\n`,
  );
  return ExitCode.Ok;
}

// The lock is held exactly while a daemon process lives; the kernel releases it when the process
// dies. No runtime directory means no daemon has run.
function daemonAlive(runDir: string): boolean {
  if (lstatSync(runDir, { throwIfNoEntry: false }) === undefined) return false;
  const lock = takeDaemonLock(runDir);
  if (lock === null) return true;
  lock.release();
  return false;
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

// Another user could have placed the lock, the pid file or the socket, so relay trusts none of them.
function notPrivate(ctx: CommandContext, runDir: string): number {
  const shown = printable(runDir);
  ctx.io.err(`relay will not use ${shown}: it must be private (mode 0700, owned by you). Fix it with: chmod 700 ${shown}\n`);
  return ExitCode.Failed;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code !== "ESRCH";
  }
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
