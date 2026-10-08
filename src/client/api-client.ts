// The command-line tool's side of the local API. This is the only file that calls fetch, and it
// always passes the unix option, so relay never opens a network connection (build-and-ci spec,
// "No network use and no telemetry"; test/build/no-network.test.ts). Every request goes through
// request(), which checks the runtime directory and the socket first, so no caller can skip the
// checks.
import { lstatSync } from "node:fs";
import { printable } from "../core/quote";
import { runtimeDirIsPrivate, socketPath } from "../daemon/paths";

export interface DaemonVersion {
  daemon_version: string;
  pid: number;
  started_at: string;
}

// A runtime directory or socket that another user could have placed. The message is written to
// standard error as it is.
export class UntrustedRuntime extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UntrustedRuntime";
  }
}

// Throws UntrustedRuntime when the runtime directory exists and is not private, because another
// user could then have placed the lock, the pid file or the socket in it.
export function checkRuntimeDir(runDir: string): void {
  if (runtimeDirIsPrivate(runDir)) return;
  const shown = printable(runDir);
  throw new UntrustedRuntime(`relay will not use ${shown}: it must be private (mode 0700, owned by you). Fix it with: chmod 700 ${shown}`);
}

// GET /v1/version. Returns null when nothing answers within timeoutMs, or the answer is not a
// v1 version object. Throws UntrustedRuntime as request() does.
export async function getVersion(runDir: string, timeoutMs: number): Promise<DaemonVersion | null> {
  const response = await request(runDir, "/v1/version", timeoutMs);
  try {
    if (response?.status !== 200) return null;
    const body = (await response.json()) as Partial<DaemonVersion> & { api?: unknown };
    if (
      body?.api !== "v1" ||
      typeof body.daemon_version !== "string" ||
      !Number.isInteger(body.pid) ||
      body.pid! <= 0 ||
      typeof body.started_at !== "string"
    ) {
      return null;
    }
    return { daemon_version: body.daemon_version, pid: body.pid!, started_at: body.started_at };
  } catch {
    return null;
  }
}

// The only connection to the daemon. Before it connects, it checks that the runtime directory is
// private and that the socket is a socket owned by this user, not a symbolic link, and throws
// UntrustedRuntime otherwise. Returns null when there is no socket or nothing answers in time.
async function request(runDir: string, path: string, timeoutMs: number): Promise<Response | null> {
  checkRuntimeDir(runDir);
  const socket = socketPath(runDir);
  const stats = lstatSync(socket, { throwIfNoEntry: false });
  if (stats === undefined) return null;
  if (!stats.isSocket() || stats.uid !== process.getuid!()) {
    throw new UntrustedRuntime(`relay will not use ${printable(socket)}: it is not a socket owned by you.`);
  }
  try {
    return await fetch(`http://relay${path}`, { unix: socket, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return null;
  }
}
