// relay daemon run: the daemon's start-up and shutdown (design.md decisions 5 and 7).
//
// Start-up: private runtime directory, the daemon lock, removal of a stale socket and pid file,
// the index (rebuilt from the files when relay.db is missing, damaged or old), the API listener,
// the pid file, then following the job files. Shutdown on SIGTERM or SIGINT: stop accepting
// connections, end the event streams with a shutdown event, let running checkpoints and switches
// finish, stop the headless agents the daemon started, let open requests finish and queued hook
// events be processed, checkpoint the database's write-ahead log, remove the socket and the pid
// file, release the lock.
import { chmodSync, lstatSync, rmSync, unlinkSync } from "node:fs";
import { createRouter } from "../api/router";
import { actionRoutes } from "../api/routes/actions";
import { accountRoutes } from "../api/routes/accounts";
import { eventRoutes } from "../api/routes/events";
import { hookRoutes } from "../api/routes/hooks";
import { jobRoutes } from "../api/routes/jobs";
import { providerRoutes } from "../api/routes/providers";
import { versionRoute } from "../api/routes/version";
import { startApiServer } from "../api/server";
import { EventStream } from "../api/sse";
import { SettingsError } from "../cli/errors";
import { loadConfig } from "../core/config/load";
import type { LogLevel, RelayConfig } from "../core/config/types";
import { printable } from "../core/quote";
import { VERSION } from "../core/version";
import { HookQueue } from "../hooks/mapping";
import { openDatabase, SCHEMA_VERSION } from "../state/db";
import { buildIndex, syncTargets } from "../state/index-builder";
import { readProjects } from "../state/projects-list";
import { Follower } from "./follow";
import { Operations } from "./operations";
import { HeadlessWorkers } from "./workers";
import { openDaemonLog } from "./log";
import { checkSocketPathLength, DaemonStartError, prepareRuntimeDir, removeStaleSocket, runtimeDir, socketPath } from "./paths";
import { pidPath, readPidFile, removeOwnPidFile, takeDaemonLock, writePidFile } from "./singleton";
import { SpoolDrain } from "./spool";

const PID_WAIT_MS = 1000;

interface DaemonOptions {
  relayHome: string;
  env: Record<string, string | undefined>;
  logLevel: LogLevel;
  config: RelayConfig;
  homedir: string;
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

  // From here a signal starts the clean shutdown, after start-up has finished. SIGHUP reads
  // config.toml again and updates the accounts.
  let reloadAccounts = () => {};
  const stopSignal = nextStopSignal(() => reloadAccounts());
  try {
    try {
      removeStaleSocket(socket);
    } catch (error) {
      if (error instanceof DaemonStartError) return refuse(error);
      throw error;
    }
    rmSync(pidPath(runDir), { force: true });

    const { db, rebuilt, brokenFile } = openDatabase(opts.relayHome);
    if (brokenFile !== null) log.warn("database_damaged", { moved_to: brokenFile });
    if (rebuilt !== null) {
      const projects = await buildIndex(db, opts.relayHome, opts.config.accounts, readProjects(opts.relayHome));
      log.info(`Rebuilt the index from ${projects} projects.`, { reason: rebuilt });
    } else {
      syncTargets(db, opts.relayHome, opts.config.accounts);
    }
    reloadAccounts = () => {
      try {
        const config = loadConfig({ relayHome: opts.relayHome, homedir: opts.homedir, uid: process.getuid!() });
        syncTargets(db, opts.relayHome, config.accounts);
        log.info("config_reloaded", { accounts: config.accounts.length });
      } catch (error) {
        if (!(error instanceof SettingsError)) throw error;
        log.warn("config_invalid", { problems: error.problems });
      }
    };

    const stream = new EventStream(db);
    const follower = new Follower({ db, relayHome: opts.relayHome, stream, log });
    const hooks = new HookQueue({ db, relayHome: opts.relayHome, homedir: opts.homedir, stream, log, catchUp: () => follower.check() });
    const spool = new SpoolDrain({ relayHome: opts.relayHome, queue: hooks, log });
    const operations = new Operations();
    const workers = new HeadlessWorkers(log);
    const engines = { relayHome: opts.relayHome, homedir: opts.homedir, env: opts.env, workers };
    const started_at = new Date().toISOString();
    const router = createRouter([
      versionRoute({ pid: process.pid, started_at, schema_version: SCHEMA_VERSION }, db, () => workers.running()),
      ...providerRoutes(db),
      ...accountRoutes(db),
      ...jobRoutes(db),
      ...actionRoutes({ db, operations, engines, catchUp: () => follower.check() }),
      ...eventRoutes(stream),
      ...hookRoutes(hooks, () => spool.poke()),
    ]);
    const server = startApiServer({ socketPath: socket, router, log });
    chmodSync(socket, 0o600);
    writePidFile(runDir, { pid: process.pid, started_at, version: VERSION, socket });
    log.info("daemon_started", { pid: process.pid, version: VERSION, socket, schema_version: SCHEMA_VERSION });
    follower.start();
    spool.start();

    const signal = await stopSignal;
    log.info("daemon_stopping", { signal });
    server.refuse();
    stream.shutdown();
    await operations.finish(log);
    await workers.stopAll();
    await server.stop();
    await spool.stop();
    await hooks.idle();
    await follower.stop();
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    removeOwnSocket(socket);
    removeOwnPidFile(runDir);
    log.info("daemon_stopped");
    return 0;
  } finally {
    lock.release();
  }
}

// The command-line tool's own signal handlers (src/cli/main.ts) exit at once. The daemon replaces
// them, so a signal starts its clean shutdown instead.
function nextStopSignal(onHangup: () => void): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.removeAllListeners(signal);
      process.on(signal, () => resolve(signal));
    }
    process.removeAllListeners("SIGHUP");
    process.on("SIGHUP", onHangup);
    // relay switch signals the process that holds a job's agent with SIGUSR1 (src/run/control.ts).
    // A job supervisor in the daemon listens for it; without one, the signal must not end the daemon.
    process.on("SIGUSR1", () => {});
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
