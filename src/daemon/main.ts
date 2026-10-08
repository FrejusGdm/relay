// relay daemon run: the daemon's start-up and shutdown (design.md decisions 5 and 7).
//
// Start-up: private runtime directory, the daemon lock, removal of a stale socket and pid file,
// the API listener, then the pid file. Shutdown on SIGTERM or SIGINT: stop accepting connections,
// let open requests finish, remove the socket and the pid file, release the lock. The database,
// the event stream, operations and headless workers join these sequences in later task groups.
import { chmodSync, lstatSync, rmSync, unlinkSync } from "node:fs";
import { createRouter } from "../api/router";
import { versionRoute } from "../api/routes/version";
import { startApiServer } from "../api/server";
import type { LogLevel } from "../core/config/types";
import { printable } from "../core/quote";
import { VERSION } from "../core/version";
import { openDaemonLog } from "./log";
import { checkSocketPathLength, DaemonStartError, prepareRuntimeDir, removeStaleSocket, runtimeDir, socketPath } from "./paths";
import { pidPath, readPidFile, removeOwnPidFile, takeDaemonLock, writePidFile } from "./singleton";

// The live-state database (task group 4) sets PRAGMA user_version to this number.
const SCHEMA_VERSION = 1;
const PID_WAIT_MS = 1000;

interface DaemonOptions {
  relayHome: string;
  env: Record<string, string | undefined>;
  logLevel: LogLevel;
  err: (text: string) => void;
}

export async function runDaemon(opts: DaemonOptions): Promise<number> {
  // Every file and the socket are created private.
  process.umask(0o077);
  const log = openDaemonLog({
    relayHome: opts.relayHome,
    level: opts.logLevel,
    onFailure: (file, reason) => opts.err(`relay: could not write to the log ${printable(file)}: ${printable(reason)}. Continuing without it.\n`),
  });
  const refuse = (error: DaemonStartError) => {
    opts.err(`${error.message}\n`);
    log.error("daemon_refused", { reason: error.message });
    return 1;
  };

  const runDir = runtimeDir(opts.env, opts.relayHome);
  const socket = socketPath(runDir);
  try {
    prepareRuntimeDir(runDir);
    checkSocketPathLength(socket);
  } catch (error) {
    if (error instanceof DaemonStartError) return refuse(error);
    throw error;
  }

  const lock = await takeDaemonLock(runDir);
  if (lock === null) {
    const pid = await runningPid(runDir);
    opts.err(pid === null ? "relay daemon is already running\n" : `relay daemon is already running (pid ${pid})\n`);
    return 0;
  }

  // From here a signal starts the clean shutdown, after start-up has finished.
  const stopSignal = nextStopSignal(() => log.info("sighup_received"));
  try {
    try {
      removeStaleSocket(socket);
    } catch (error) {
      if (error instanceof DaemonStartError) return refuse(error);
      throw error;
    }
    rmSync(pidPath(runDir), { force: true });

    const started_at = new Date().toISOString();
    const router = createRouter([versionRoute({ pid: process.pid, started_at, schema_version: SCHEMA_VERSION })]);
    const server = startApiServer({ socketPath: socket, router, log });
    chmodSync(socket, 0o600);
    writePidFile(runDir, { pid: process.pid, started_at, version: VERSION, socket });
    log.info("daemon_started", { pid: process.pid, version: VERSION, socket, schema_version: SCHEMA_VERSION });

    const signal = await stopSignal;
    log.info("daemon_stopping", { signal });
    await server.stop();
    removeOwnSocket(socket);
    removeOwnPidFile(runDir);
    log.info("daemon_stopped");
    return 0;
  } finally {
    lock.release();
  }
}

// The command-line tool's own signal handlers (src/cli/main.ts) exit at once. The daemon replaces
// them, so a signal starts its clean shutdown instead. SIGHUP will reload config.toml once the
// daemon keeps an index of accounts (task group 4); until then it is only logged, so that it does
// not stop the daemon.
function nextStopSignal(onHangup: () => void): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.removeAllListeners(signal);
      process.on(signal, () => resolve(signal));
    }
    process.removeAllListeners("SIGHUP");
    process.on("SIGHUP", onHangup);
  });
}

// Another daemon that has just taken the lock may not have written its pid file yet.
async function runningPid(runDir: string): Promise<number | null> {
  const deadline = Date.now() + PID_WAIT_MS;
  for (;;) {
    const pid = readPidFile(runDir)?.pid ?? null;
    if (pid !== null || Date.now() >= deadline) return pid;
    await Bun.sleep(50);
  }
}

function removeOwnSocket(path: string): void {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSocket()) unlinkSync(path);
}
