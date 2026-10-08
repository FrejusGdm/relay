// Starting the daemon from the command-line tool (design.md decision 6). The daemon runs as a
// detached process in its own session, with standard input from /dev/null and its standard output
// and error appended to logs/daemon.stderr.log, so it outlives the terminal.
import { spawn } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../core/version";
import { runtimeDir } from "../daemon/paths";
import { getVersion } from "./api-client";

const FIRST_ANSWER_MS = 300;
const START_WAIT_MS = 3000;
const POLL_MS = 50;

// "not_responding": the new daemon exited 0 because another process holds the daemon lock, and
// that process does not answer.
export type StartResult = { state: "running" | "started"; pid: number } | { state: "not_responding" | "failed" };

interface StartOptions {
  relayHome: string;
  env: Record<string, string | undefined>;
  err: (text: string) => void;
}

// Asks the running daemon for its version; when nothing answers, starts one and waits up to
// 3 seconds for it to answer. A daemon of another version gets a notice, once. Throws
// UntrustedRuntime, before any connection, when the runtime directory or the socket could have
// been placed by another user.
export async function startDaemon(opts: StartOptions): Promise<StartResult> {
  const runDir = runtimeDir(opts.env, opts.relayHome);
  const running = await getVersion(runDir, FIRST_ANSWER_MS);
  if (running !== null) {
    if (running.daemon_version !== VERSION) {
      opts.err(
        `The relay daemon is running version ${running.daemon_version}; this command is version ${VERSION}. ` +
          "Restart it with: relay daemon restart\n",
      );
    }
    return { state: "running", pid: running.pid };
  }

  // Set by the exit handler below; the cast stops TypeScript from narrowing it to null.
  let exitCode = null as number | null;
  const errFd = openStderrLog(opts.relayHome);
  try {
    const [command, ...args] = daemonCommand();
    const child = spawn(command!, args, {
      detached: true,
      stdio: ["ignore", errFd ?? "ignore", errFd ?? "ignore"],
      cwd: opts.relayHome,
      env: opts.env,
    });
    // A daemon that refuses to start exits with 1; one that finds another daemon exits with 0, and
    // that daemon may still be starting, so polling goes on.
    child.on("exit", (code) => (exitCode = code ?? 1));
    child.on("error", () => (exitCode = 1));
    child.unref();
  } finally {
    if (errFd !== null) closeSync(errFd);
  }

  const deadline = Date.now() + START_WAIT_MS;
  while ((exitCode === null || exitCode === 0) && Date.now() < deadline) {
    const answer = await getVersion(runDir, FIRST_ANSWER_MS);
    if (answer !== null) return { state: exitCode === 0 ? "running" : "started", pid: answer.pid };
    await Bun.sleep(POLL_MS);
  }
  return { state: exitCode === 0 ? "not_responding" : "failed" };
}

// The daemon's crash traces go to logs/daemon.stderr.log. When it cannot be opened, they are lost,
// and daemon.log still has everything else.
function openStderrLog(relayHome: string): number | null {
  try {
    const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;
    return openSync(join(relayHome, "logs", "daemon.stderr.log"), flags, 0o600);
  } catch {
    return null;
  }
}

// The compiled program runs itself. From source, Bun runs src/cli/main.ts without reading .env
// files, as the relay script in package.json does.
function daemonCommand(): string[] {
  if (Bun.main.startsWith("/$bunfs/")) return [process.execPath, "daemon", "run"];
  return [process.execPath, "--no-env-file", join(import.meta.dir, "..", "cli", "main.ts"), "daemon", "run"];
}
