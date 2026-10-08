// The command-line tool's side of the local API. This is the only file that calls fetch, and it
// always passes the unix option, so relay never opens a network connection (build-and-ci spec,
// "No network use and no telemetry"; test/build/no-network.test.ts).

export interface DaemonVersion {
  daemon_version: string;
  pid: number;
  started_at: string;
}

// GET /v1/version. Returns null when nothing answers within timeoutMs, or the answer is not a
// v1 version object.
export async function getVersion(socketPath: string, timeoutMs: number): Promise<DaemonVersion | null> {
  try {
    const response = await fetch("http://relay/v1/version", {
      unix: socketPath,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) return null;
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
