// GET /v1/version (design.md decision 14). Clients check capabilities, not daemon_version, before
// they use an endpoint (decision 16). stream_epoch changes whenever the index, and with it the
// event stream's numbering, is rebuilt (the Mac app proposal, design decision 17, requirement C).
import type { Database } from "bun:sqlite";
import { VERSION } from "../../core/version";
import { streamEpoch } from "../../state/db";
import type { Route } from "../router";
import { snapshotResponse } from "../snapshot";

export interface DaemonInfo {
  pid: number;
  started_at: string;
  schema_version: number;
}

// Each task group that adds endpoints adds their capability here; jobs.checkpoint and jobs.switch
// come later.
const CAPABILITIES = ["accounts", "jobs", "events.sse", "hooks"];

export function versionRoute(daemon: DaemonInfo, db: Database): Route {
  return {
    method: "GET",
    path: "/v1/version",
    handle: () =>
      snapshotResponse(db, () => ({
        api: "v1",
        daemon_version: VERSION,
        pid: daemon.pid,
        started_at: daemon.started_at,
        schema_version: daemon.schema_version,
        stream_epoch: streamEpoch(db),
        capabilities: CAPABILITIES,
        agents_running: [],
      })),
  };
}
