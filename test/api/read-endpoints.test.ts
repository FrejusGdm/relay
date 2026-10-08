// Task 5.1: the read endpoints answer in the shapes of design decision 14. The index is filled
// through the same applyEvent the daemon uses, and each answer is compared with a file in
// test/api/fixtures/.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRouter, type Router } from "../../src/api/router";
import { accountRoutes } from "../../src/api/routes/accounts";
import { jobRoutes } from "../../src/api/routes/jobs";
import { providerRoutes } from "../../src/api/routes/providers";
import type { Account } from "../../src/core/config/types";
import type { RelayEvent } from "../../src/job/events";
import { applyEvent } from "../../src/state/apply-event";
import { STALE_REASON } from "../../src/state/availability";
import { openDatabase } from "../../src/state/db";
import { syncTargets } from "../../src/state/index-builder";
import { removeTempRelayHomes, tempRelayHome } from "../helpers/relay-home";

const FIXTURES = join(import.meta.dir, "fixtures");
const JOB = "3f9a2c1d";
// A process ID no system hands out, so the worker that used it reads as stopped.
const GONE_PID = 2_147_483_000;

let db: Database;
let router: Router;

const account = (id: `${"claude" | "codex"}:${string}`): Account => {
  const [provider, name] = id.split(":") as ["claude" | "codex", string];
  return { id, provider, name, profileDir: `/profiles/${name}`, profileDirIsDefault: false, credentialEnv: [], kind: null };
};

let eventId = 0;
const event = (ts: string, type: string, data: Record<string, unknown>): RelayEvent =>
  ({ v: 1, id: ++eventId, ts, job: JOB, type, actor: "relay", data });

beforeAll(() => {
  const relayHome = tempRelayHome();
  db = openDatabase(relayHome).db;
  syncTargets(db, relayHome, [account("claude:work"), account("codex:personal"), account("claude:home")]);
  db.prepare("INSERT INTO projects (root_path, missing, last_seen_at) VALUES ('/projects/app', 0, '2026-10-07T14:00:00.000Z')").run();
  db.prepare(
    "INSERT INTO jobs (id, project_root, title, state, updated_at) VALUES (?, '/projects/app', 'Build authentication', 'active', '2026-10-07T14:00:00.000Z')",
  ).run(JOB);
  const events = [
    event("2026-10-07T14:01:00.000Z", "checkpoint_saved", { number: 7, commit: "912ec1".padEnd(40, "0"), kind: "handoff", message: "Login form done" }),
    event("2026-10-07T14:02:00.000Z", "worker_started", { worker_id: "w1", target: "claude:work", mode: "interactive", pid: GONE_PID, provider_session_id: "s1", from_handoff: null }),
    event("2026-10-07T14:02:11.402Z", "availability", { worker_id: "w1", target: "claude:work", status: "rate_limited", reason: "Claude Code reported a rate limit", retry_at: null, measured_at: "2026-10-07T14:02:11.402Z", source: "hook", windows: [] }),
    event("2026-10-07T14:03:00.000Z", "worker_started", { worker_id: "w2", target: "codex:personal", mode: "headless", pid: null, provider_session_id: null, from_handoff: 1 }),
    event("2026-10-07T14:30:02.000Z", "availability", { worker_id: null, target: "claude:home", status: "available", reason: null, retry_at: null, measured_at: "2026-10-07T14:30:02.000Z", source: "status_line", windows: [{ name: "five_hour", window_minutes: 300, used_percent: 9, resets_at: "2026-10-07T19:00:00.000Z" }] }),
    event("2020-01-01T00:00:00.000Z", "availability", { worker_id: null, target: "claude:old", status: "rate_limited", reason: "Claude Code reported a rate limit", retry_at: "2020-01-01T05:00:00.000Z", measured_at: "2020-01-01T00:00:00.000Z", source: "hook", windows: [] }),
  ];
  for (const each of events) applyEvent(db, JOB, each);
  router = createRouter([...providerRoutes(db), ...accountRoutes(db), ...jobRoutes(db)]);
});

afterAll(() => {
  db.close();
  removeTempRelayHomes();
});

async function answer(path: string): Promise<{ status: number; seq: string | null; body: unknown }> {
  const response = await router.handle(new Request(`http://relay${path}`));
  return { status: response.status, seq: response.headers.get("relay-stream-seq"), body: await response.json() };
}

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
}

function keys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keys);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, inner]) => [key, ...keys(inner)]);
}

test.each([
  ["/v1/providers", "providers"],
  ["/v1/accounts", "accounts"],
  ["/v1/accounts/claude:work", "account-rate-limited"],
  ["/v1/accounts/codex:personal", "account-unmeasured"],
  ["/v1/jobs", "jobs"],
  ["/v1/jobs/3f9a2c1d", "job"],
  ["/v1/jobs/3f9a2c1d/workers", "workers"],
])("GET %s matches fixtures/%s.json and carries Relay-Stream-Seq", async (path, name) => {
  const { status, seq, body } = await answer(path);
  expect(status).toBe(200);
  expect(seq).toBe("0");
  expect(body).toEqual(fixture(name));
  expect(keys(body)).not.toContain("total");
});

test("an unmeasured account has every availability field, null, and no usage", async () => {
  expect(((await answer("/v1/accounts/codex:personal")).body as any).account).toMatchObject({
    availability: { status: "unknown", reason: null, retry_at: null, measured_at: null, source: null },
    usage: [],
  });
});

test("a worker whose process is gone shows stopped, and one without a process starting", async () => {
  const workers = ((await answer("/v1/jobs/3f9a2c1d/workers")).body as any).workers;
  expect(workers.map((worker: { id: string; state: string }) => [worker.id, worker.state])).toEqual([["w2", "starting"], ["w1", "stopped"]]);
});

test("a limit whose reset time passed shows unknown with the stale reason", async () => {
  const { body } = await answer("/v1/accounts/claude:old");
  expect((body as any).account).toMatchObject({
    configured: false,
    availability: { status: "unknown", reason: STALE_REASON, retry_at: "2020-01-01T05:00:00.000Z" },
  });
});

test.each([
  ["/v1/jobs/ffffffff", 404, "job-not-found"],
  ["/v1/jobs/ffffffff/workers", 404, "job-not-found"],
  ["/v1/accounts/codex:work", 404, "target-not-found"],
  ["/v1/accounts/codex%20personal", 400, "invalid-target"],
])("GET %s answers %d as in fixtures/%s.json", async (path, status, name) => {
  const result = await answer(path);
  expect(result.status).toBe(status);
  expect(result.body).toEqual(fixture(name));
});

test("the fixture files exist for every case", () => {
  for (const name of ["providers", "accounts", "account-rate-limited", "account-unmeasured", "jobs", "job", "workers", "job-not-found", "target-not-found", "invalid-target"]) {
    expect(existsSync(join(FIXTURES, `${name}.json`))).toBe(true);
  }
});
