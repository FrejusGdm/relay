// GET /v1/version (design.md decision 14). Clients check capabilities, not daemon_version, before
// they use an endpoint (decision 16).
import { VERSION } from "../../core/version";
import { jsonResponse } from "../errors";
import type { Route } from "../router";

export interface DaemonInfo {
  pid: number;
  started_at: string;
  schema_version: number;
}

// Each task group that adds endpoints adds their capability here: accounts, jobs, events.sse,
// jobs.checkpoint, jobs.switch and hooks.
const CAPABILITIES: string[] = [];

export function versionRoute(daemon: DaemonInfo): Route {
  return {
    method: "GET",
    path: "/v1/version",
    handle: () =>
      jsonResponse(200, {
        api: "v1",
        daemon_version: VERSION,
        pid: daemon.pid,
        started_at: daemon.started_at,
        schema_version: daemon.schema_version,
        capabilities: CAPABILITIES,
        agents_running: [],
      }),
  };
}
