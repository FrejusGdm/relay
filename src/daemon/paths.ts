// The daemon's runtime directory and socket path, and the checks that run before the socket is
// created (design.md decisions 1 and 2, the local-api spec). The command-line tool uses the same
// functions to find the socket.
import { lstatSync, mkdirSync, unlinkSync, type Stats } from "node:fs";
import { isAbsolute, join } from "node:path";
import { reasonOf } from "../core/log";
import { printable } from "../core/quote";

// A refusal to start. The message is written to standard error and to daemon.log.
export class DaemonStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonStartError";
  }
}

// sun_path is 104 bytes on macOS and 108 on Linux, including the final zero byte.
const SOCKET_PATH_MAX: Record<string, number> = { darwin: 103, linux: 107 };

// $RELAY_HOME/run, except on Linux when RELAY_HOME is not set and XDG_RUNTIME_DIR is: then
// $XDG_RUNTIME_DIR/relay. Setting RELAY_HOME always keeps everything inside it, so tests are
// hermetic.
export function runtimeDir(
  env: Record<string, string | undefined>,
  relayHome: string,
  platform: string = process.platform,
): string {
  const xdg = env.XDG_RUNTIME_DIR;
  if (platform === "linux" && !env.RELAY_HOME && xdg && isAbsolute(xdg)) return join(xdg, "relay");
  return join(relayHome, "run");
}

export function socketPath(dir: string): string {
  return join(dir, "relay.sock");
}

// Creates the directory with mode 0700 when it is missing, then refuses a symbolic link, anything
// that is not a directory, a directory owned by another user, and any permission for group or
// others. relay never changes the mode of a directory it did not create in this call. lstat is a
// parameter so that tests can simulate another owner.
export function prepareRuntimeDir(
  dir: string,
  lstat: (path: string) => Stats = lstatSync,
  uid: number = process.getuid!(),
): void {
  const shown = printable(dir);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    // A symbolic link that leads nowhere makes mkdir fail; lstat below reports it.
    if ((error as { code?: string }).code !== "EEXIST") {
      throw new DaemonStartError(`relay cannot start: it cannot create ${shown}: ${reasonOf(error)}.`);
    }
  }
  const stats = lstat(dir);
  if (stats.isSymbolicLink()) throw new DaemonStartError(`relay cannot start: ${shown} is a symbolic link.`);
  if (!stats.isDirectory() || stats.uid !== uid || (stats.mode & 0o077) !== 0) {
    throw new DaemonStartError(
      `relay cannot start: ${shown} must be private (mode 0700, owned by you). Fix it with: chmod 700 ${shown}`,
    );
  }
}

// For the command-line tool before it trusts what it finds in the runtime directory: true when the
// directory is missing (no daemon has run) or private, false when another user could have placed a
// lock, a pid file or a socket in it.
export function runtimeDirIsPrivate(dir: string, uid: number = process.getuid!()): boolean {
  const stats = lstatSync(dir, { throwIfNoEntry: false });
  if (stats === undefined) return true;
  return stats.isDirectory() && !stats.isSymbolicLink() && stats.uid === uid && (stats.mode & 0o077) === 0;
}

export function checkSocketPathLength(path: string, platform: string = process.platform): void {
  const problem = socketPathProblem(path, platform);
  if (problem !== null) throw new DaemonStartError(`relay cannot start: ${problem}.`);
}

// Why a socket path cannot be used, or null when it can. The command-line tool names this reason
// when the daemon cannot start, so the person need not look in daemon.log.
export function socketPathProblem(path: string, platform: string = process.platform): string | null {
  const max = SOCKET_PATH_MAX[platform] ?? 103;
  if (Buffer.byteLength(path) <= max) return null;
  return `the socket path ${printable(path)} is too long (at most ${max} bytes on ${platform === "linux" ? "Linux" : "macOS"}). Set RELAY_HOME to a shorter path`;
}

// Removes a socket left behind by a daemon that crashed. Called only while the daemon lock is
// held, so no running daemon owns it. Anything else at the path is refused.
export function removeStaleSocket(path: string): void {
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (stats === undefined) return;
  if (!stats.isSocket()) throw new DaemonStartError(`relay cannot start: ${printable(path)} exists and is not a socket.`);
  unlinkSync(path);
}
