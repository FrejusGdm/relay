// The only module that starts agent processes (add-provider-adapters, design decision 5).
// test/adapters/no-other-spawn.test.ts fails if another file under src/adapters/ starts one.
//
// relay sends signals only to the child it holds (for a headless child, to the process group the
// child leads), and only while that child has not been reaped, so a signal can never reach a
// process that later reused the same process ID. It never signals a process found by name, by
// port or by a process ID read from a file.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { now } from "../platform/clock";
import { LineSplitter } from "./lines";

export type AgentSignal = "SIGINT" | "SIGTERM" | "SIGKILL";
export interface ExitStatus { code: number | null; signal: string | null }

// What a process holds for its owner: its ID, its end, and the only way to signal it.
export interface AgentProcess {
  readonly pid: number | null;
  readonly exited: Promise<ExitStatus>;
  running(): boolean;
  // Sends the signal to the child, or nothing once it has exited. Returns whether it was sent.
  signal(name: AgentSignal): boolean;
}

export interface HeadlessProcess extends AgentProcess {
  // Writes to the child's standard input. Only for input "pipe".
  write(text: string): Promise<void>;
  closeInput(): void;
  // Adds a line "relay <text>" to the worker log, while it is open.
  note(text: string): void;
}

export interface HeadlessOptions {
  path: string;                       // absolute path of the program
  args: string[];
  cwd: string;
  env: Record<string, string>;
  // "pipe": relay writes and later closes the input. "eof": the input is at end of file at once,
  // for a program that takes its prompt as an argument.
  input: "pipe" | "eof";
  logPath: string;
  // Called with every complete line, in order, after it was written to the worker log.
  onLine(stream: "out" | "err", line: string): void;
  // Called once all output has been read, for the last notes of the worker log.
  closingNotes?(): string[];
}

export interface InteractiveOptions {
  path: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

const LOG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const WORKER_LOG_NAME = /^[0-9a-f]{8}-[0-9a-f]{8}\.log$/;
// After the child exits, how long relay waits for the last output a program that the child
// started in the background might still hold open.
const OUTPUT_GRACE_MS = 2000;

// Children still running, stopped when relay exits so that none outlives it.
const live = new Set<{ signal(name: AgentSignal): boolean }>();
let exitHandlerInstalled = false;

function track(child: { signal(name: AgentSignal): boolean }): () => void {
  if (!exitHandlerInstalled) {
    exitHandlerInstalled = true;
    process.on("exit", () => {
      for (const entry of live) entry.signal("SIGTERM");
    });
  }
  live.add(child);
  return () => live.delete(child);
}

// Opens the worker log for appending, creating it with mode 0600 in a folder with mode 0700. It
// refuses a folder or file that is a symbolic link, belongs to someone else or is not a regular
// file, such as a named pipe, which could otherwise block relay.
// True when the folder is a real folder, not a symbolic link, and belongs to the current user.
function isOwnFolder(path: string): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return stat !== undefined && stat.isDirectory() && stat.uid === process.getuid!();
}

function openWorkerLog(path: string): number {
  const folder = dirname(path);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const uid = process.getuid!();
  if (!isOwnFolder(folder)) throw new Error(`The worker log folder ${folder} is not safe to use.`);
  if ((lstatSync(folder).mode & 0o077) !== 0) chmodSync(folder, 0o700);
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const fd = openSync(path, flags, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== uid) throw new Error(`The worker log ${path} is not safe to use.`);
    fchmodSync(fd, 0o600);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return fd;
}

// Starts a headless agent in its own process group, so that Ctrl+C in the terminal reaches relay
// only, and drains both of its outputs into the worker log from start to exit.
export function startHeadless(options: HeadlessOptions): Promise<HeadlessProcess> {
  let log: number;
  try {
    log = openWorkerLog(options.logPath);
  } catch (error) {
    return Promise.reject(error);
  }
  let logOpen = true;
  const closeLog = () => {
    if (logOpen) closeSync(log);
    logOpen = false;
  };
  let child: ChildProcess;
  try {
    child = spawn(options.path, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.input === "pipe" ? "pipe" : "ignore", "pipe", "pipe"],
      detached: true,
    });
  } catch (error) {
    closeLog();
    return Promise.reject(error);
  }

  let reaped = false;
  // Set when relay stopped reading output that a program the agent started kept open after the
  // agent exited. A last line cut off this way goes to the log, but not to the adapter.
  let cut = false;
  const writeLog = (text: string) => {
    if (!logOpen) return;
    try {
      writeSync(log, text);
    } catch {
      // A full disk must not stop the agent or relay; the adapter still receives every line.
      closeLog();
    }
  };
  const drained: Promise<void>[] = [];
  for (const [stream, prefix] of [[child.stdout!, "out"], [child.stderr!, "err"]] as const) {
    const splitter = new LineSplitter();
    const deliver = (lines: string[], toAdapter = true) => {
      if (lines.length === 0) return;
      writeLog(lines.map((line) => `${prefix} ${line}\n`).join(""));
      if (toAdapter) for (const line of lines) options.onLine(prefix, line);
    };
    stream.on("data", (chunk: Buffer) => deliver(splitter.push(chunk)));
    stream.on("error", () => {});
    drained.push(new Promise((done) => stream.once("close", () => {
      deliver(splitter.end(), !cut);
      done();
    })));
  }
  child.stdin?.on("error", () => {});

  const handle: HeadlessProcess = {
    get pid() {
      return child.pid ?? null;
    },
    exited: new Promise<ExitStatus>((resolveExit) => {
      child.once("exit", (code, signal) => {
        reaped = true;
        untrack();
        const grace = setTimeout(() => {
          cut = true;
          child.stdout?.destroy();
          child.stderr?.destroy();
        }, OUTPUT_GRACE_MS);
        void Promise.all(drained).then(() => {
          clearTimeout(grace);
          for (const text of options.closingNotes?.() ?? []) writeLog(`relay ${text}\n`);
          closeLog();
          resolveExit({ code, signal });
        });
      });
    }),
    running: () => !reaped,
    // The child leads its own process group, so the signal goes to the group and also reaches the
    // programs the agent started, as Ctrl+C in a terminal would. Until the child is reaped, its
    // process ID, and so its group ID, cannot belong to any other process.
    signal(name) {
      if (reaped || child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return false;
      try {
        process.kill(-child.pid, name);
        return true;
      } catch {
        return child.kill(name);
      }
    },
    write(text) {
      const input = child.stdin;
      if (input === null || input.writableEnded || input.destroyed) {
        return Promise.reject(new Error("The agent's input is closed."));
      }
      return new Promise((done, fail) => input.write(text, (error) => (error ? fail(error) : done())));
    },
    note(text) {
      writeLog(`relay ${text}\n`);
    },
    closeInput() {
      child.stdin?.end();
    },
  };
  const untrack = track(handle);

  return new Promise((resolveStart, rejectStart) => {
    child.once("spawn", () => resolveStart(handle));
    child.once("error", (error) => {
      if (child.pid !== undefined) return;
      untrack();
      closeLog();
      rejectStart(error);
    });
  });
}

// Starts an interactive agent in the person's terminal. While it runs, relay ignores SIGINT and
// SIGQUIT the way a shell does, so only the agent handles Ctrl+C; relay's own handlers come back
// when the agent exits.
export function startInteractive(options: InteractiveOptions): AgentProcess {
  const child = Bun.spawn([options.path, ...options.args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["inherit", "inherit", "inherit"],
  });
  const saved = (["SIGINT", "SIGQUIT"] as const).map((name) => {
    // rawListeners keeps the wrappers of handlers added with once, so they stay one-time handlers.
    const listeners = process.rawListeners(name);
    process.removeAllListeners(name);
    const ignore = () => {};
    process.on(name, ignore);
    return { name, listeners, ignore };
  });
  let reaped = false;
  const handle: AgentProcess = {
    pid: child.pid,
    exited: child.exited.then(() => {
      reaped = true;
      untrack();
      for (const { name, listeners, ignore } of saved) {
        process.removeListener(name, ignore);
        for (const listener of listeners) process.on(name, listener as () => void);
      }
      return { code: child.exitCode, signal: child.signalCode ?? null };
    }),
    running: () => !reaped,
    signal(name) {
      if (reaped || child.exitCode !== null || child.signalCode !== null) return false;
      child.kill(name);
      return true;
    },
  };
  const untrack = track(handle);
  return handle;
}

// Deletes worker logs, named <job>-<worker>.log, last changed more than 14 days ago, in
// RELAY_HOME/logs/workers/. It does nothing when logs/ or logs/workers/ is a symbolic link or
// belongs to someone else, so it can never delete files elsewhere.
export function deleteOldWorkerLogs(relayHome: string): void {
  const logs = join(relayHome, "logs");
  const folder = join(logs, "workers");
  if (!isOwnFolder(logs) || !isOwnFolder(folder)) return;
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return;
  }
  const oldest = now().getTime() - LOG_MAX_AGE_MS;
  for (const name of names.filter((name) => WORKER_LOG_NAME.test(name))) {
    const path = join(folder, name);
    try {
      const stat = lstatSync(path);
      if (stat.isFile() && stat.mtimeMs < oldest) rmSync(path);
    } catch {
      // A log that another relay removed at the same time is already gone.
    }
  }
}

export interface ShortCommandOptions {
  path: string;
  args: string[];
  env: Record<string, string>;
  timeoutMs: number;
}

// Runs a short provider command, such as `claude --version` or `codex login status`, with its input
// at end of file, and returns its exit code and up to 1 MiB of its standard output. Its standard
// error is discarded. A command still running at the time limit is killed through the held child.
export function runShortCommand(options: ShortCommandOptions): Promise<{ code: number | null; stdout: string }> {
  const limit = 1_048_576;
  return new Promise((done, fail) => {
    let child: ChildProcess;
    try {
      child = spawn(options.path, options.args, { env: options.env, stdio: ["ignore", "pipe", "ignore"] });
    } catch (error) {
      fail(error);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout!.on("data", (chunk: Buffer) => {
      if (size < limit) chunks.push(chunk.subarray(0, limit - size));
      size += chunk.length;
    });
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, options.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

// Runs a provider command attached to the person's terminal, such as `claude auth login`, and
// waits for it. relay does not read the terminal while it runs.
export async function runInTerminal(options: InteractiveOptions): Promise<ExitStatus> {
  return startInteractive(options).exited;
}
