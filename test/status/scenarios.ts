// Status data for the relay status tests: the situations of tasks 10.1 and 10.2, built in the API
// shapes. NOW is 14:32 UTC on 2026-10-07. relay status shows local times, so the tests that use
// these scenarios run in UTC also when a plain `bun test` starts them.
process.env.TZ = "UTC";

import type { StatusData } from "../../src/status/model";
import type { AccountView, JobView, WorkerView } from "../../src/state/queries";

export const NOW = new Date("2026-10-07T14:32:00.000Z");
const JOB = "3f9a2c1d";

export function account(target: string, availability: Partial<AccountView["availability"]> = {}, usage: AccountView["usage"] = []): AccountView {
  const [provider, name] = target.split(":") as [string, string];
  return {
    target,
    provider,
    provider_name: provider === "claude" ? "Claude Code" : "Codex",
    account: name,
    configured: true,
    availability: { status: "unknown", reason: null, retry_at: null, measured_at: null, source: null, ...availability },
    usage,
  };
}

export function worker(id: string, target: string, state: WorkerView["state"], fromHandoff: boolean, startedAt: string): WorkerView {
  return {
    id,
    job_id: JOB,
    target,
    mode: "interactive",
    state,
    pid: state === "ended" ? null : 5120,
    provider_session_id: null,
    from_handoff: fromHandoff,
    started_at: startedAt,
    ended_at: state === "ended" ? "2026-10-07T14:20:00.000Z" : null,
    exit_code: state === "ended" ? 0 : null,
    end_reason: state === "ended" ? "stopped_by_switch" : null,
  };
}

export function job(overrides: Partial<JobView> = {}): JobView {
  return {
    id: JOB,
    title: "Build authentication",
    state: "active",
    project_root: "/projects/app",
    project_missing: false,
    current_worker: null,
    last_checkpoint: {
      number: 7,
      commit: "912ec1d0a4b6c8e0f2a4b6c8d0e2f4a6b8c0d2e4",
      ref: `refs/relay/jobs/${JOB}/checkpoints/7`,
      kind: "handoff",
      created_at: "2026-10-07T14:30:00.000Z",
      message: "Login form done",
    },
    updated_at: "2026-10-07T14:30:00.000Z",
    ...overrides,
  };
}

const limitedWork = account("claude:work", {
  status: "rate_limited", reason: "Claude Code reported a rate limit", measured_at: "2026-10-07T14:02:11.402Z", source: "hook",
});
const measuredHome = account(
  "claude:home",
  { status: "available", measured_at: "2026-10-07T14:30:02.000Z", source: "status_line" },
  [{ window: "five_hour", window_minutes: 300, used_percent: 9, resets_at: "2026-10-07T19:00:00.000Z", measured_at: "2026-10-07T14:30:02.000Z" }],
);

const ended = worker("w1", "claude:work", "ended", false, "2026-10-07T13:00:00.000Z");
const running = worker("w2", "codex:personal", "running", true, "2026-10-07T14:20:05.000Z");

export const SCENARIOS: Record<string, StatusData> = {
  "after-handoff": {
    job: job({ current_worker: running }),
    workers: [running, ended],
    accounts: [measuredHome, limitedWork, account("codex:personal")],
    daemon: "running",
    savedState: false,
  },
  "known-reset": {
    job: job(),
    workers: [],
    accounts: [account("claude:work", { status: "rate_limited", retry_at: "2026-10-07T18:00:00.000Z", measured_at: "2026-10-07T14:02:11.402Z", source: "hook" })],
    daemon: "running",
    savedState: false,
  },
  "never-measured": {
    job: job({ current_worker: worker("w3", "claude:work", "running", false, "2026-10-07T14:00:00.000Z") }),
    workers: [],
    accounts: [account("claude:work"), account("claude:home")],
    daemon: "running",
    savedState: false,
  },
  "stale-reset": {
    job: job(),
    workers: [],
    accounts: [
      account("claude:work", {
        status: "unknown", reason: "The reset time has passed; relay has not checked since.",
        retry_at: "2026-10-07T12:00:00.000Z", measured_at: "2026-10-07T07:00:00.000Z", source: "hook",
      }),
    ],
    daemon: "running",
    savedState: false,
  },
  "no-worker": {
    job: job(),
    workers: [ended],
    accounts: [measuredHome, limitedWork],
    daemon: "running",
    savedState: false,
  },
  "no-checkpoint": {
    job: job({ last_checkpoint: null }),
    workers: [],
    accounts: [account("codex:personal")],
    daemon: "not_running",
    savedState: true,
  },
  "long-title": {
    job: job({ title: "Move the whole authentication flow to the new session store and remove the old one" }),
    workers: [],
    accounts: [measuredHome, account("codex:personal", { status: "available", measured_at: "2026-10-07T14:00:00.000Z", source: "app_server" }, [
      { window: "seven_day", window_minutes: 10080, used_percent: 60, resets_at: null, measured_at: "2026-10-06T09:00:00.000Z" },
      { window: "five_hour", window_minutes: 300, used_percent: 40, resets_at: null, measured_at: "2026-10-07T14:00:00.000Z" },
    ])],
    daemon: "running",
    savedState: false,
  },
};
