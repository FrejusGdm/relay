// Task 4.3: building the index from two projects' files, events, checkpoints and an
// availability.json, with the event fields of phases 2 to 4.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Account } from "../../src/core/config/types";
import { appendEvent, type JobRef } from "../../src/job/events";
import { openDatabase } from "../../src/state/db";
import { buildIndex } from "../../src/state/index-builder";
import { getAccount, getJob, listAccounts, listWorkers } from "../../src/state/queries";
import { FAKE_SCANNER, jobId, relay, setUpJob } from "../helpers/job";
import { removeTempRelayHomes, tempRelayHome } from "../helpers/relay-home";
import type { ScratchRepo } from "../helpers/scratch-repo";

const scratches: ScratchRepo[] = [];
afterEach(() => {
  for (const scratch of scratches.splice(0).reverse()) scratch.cleanup();
  removeTempRelayHomes();
});

const account = (id: `${"claude" | "codex"}:${string}`): Account => {
  const [provider, name] = id.split(":") as ["claude" | "codex", string];
  return { id, provider, name, profileDir: `/profiles/${name}`, profileDirIsDefault: false, credentialEnv: [], kind: null };
};

// A process ID that no longer exists.
async function deadPid(): Promise<number> {
  const child = Bun.spawn(["true"]);
  await child.exited;
  return child.pid;
}

test("jobs, workers, the last checkpoint and the newest availability per account come from the files", async () => {
  const first = await setUpJob("full", undefined, FAKE_SCANNER);
  scratches.push(first);
  first.write("feature.ts", "export const done = true;\n");
  expect((await relay(first, ["checkpoint", "-m", "Feature done"], { quiet: true })).code).toBe(0);
  const second = await setUpJob("full", undefined, FAKE_SCANNER);
  scratches.push(second);

  const job: JobRef = { id: jobId(first), worktreeRoot: first.repo, relayHome: first.relayHome };
  const pid = await deadPid();
  await appendEvent(job, "worker_started", {
    worker_id: "w1", target: "claude:work", mode: "interactive", pid, provider_session_id: null, from_handoff: null,
  });
  await appendEvent(job, "worker_session_identified", { worker_id: "w1", provider_session_id: "session-1" });
  await appendEvent(job, "availability", {
    worker_id: "w1", target: "claude:work", status: "rate_limited", reason: "Claude Code reported a rate limit",
    retry_at: null, measured_at: "2026-10-07T14:02:11.402Z", source: "hook", windows: [],
  });
  await appendEvent(job, "worker_ended", { worker_id: "w1", exit_code: 0, signal: null, end_reason: "stopped_by_switch" });
  await appendEvent(job, "handoff", { from_worker_id: "w1", to_target: "codex:personal", checkpoint_number: 2 });
  await appendEvent(job, "worker_started", {
    worker_id: "w2", target: "codex:personal", mode: "headless", pid: process.pid, provider_session_id: null, from_handoff: 1,
  });
  // An older reading in the second project does not replace the newer one.
  await appendEvent({ id: jobId(second), worktreeRoot: second.repo, relayHome: second.relayHome }, "availability", {
    worker_id: null, target: "claude:work", status: "available", reason: null,
    retry_at: null, measured_at: "2026-10-07T13:00:00.000Z", source: "hook", windows: [],
  });

  const relayHome = tempRelayHome();
  mkdirSync(join(relayHome, "accounts", "codex-personal"), { recursive: true });
  writeFileSync(
    join(relayHome, "accounts", "codex-personal", "availability.json"),
    JSON.stringify({
      v: 1, account: "codex:personal", state: "available", retry_at: null,
      windows: [
        { name: "seven_day", window_minutes: 10080, used_percent: 30, resets_at: "2026-10-12T09:00:00.000Z", source: "app_server" },
        { name: "five_hour", window_minutes: 300, used_percent: 9, resets_at: "2026-10-07T19:00:00.000Z", source: "app_server" },
      ],
      observed_at: "2026-10-07T14:30:02.000Z", source: "app_server", detail: null, spool_seen_until: null,
    }),
  );

  const { db } = openDatabase(relayHome);
  const accounts = [account("claude:work"), account("codex:personal"), account("claude:home")];
  expect(await buildIndex(db, relayHome, accounts, [first.repo, second.repo])).toBe(2);

  const indexed = getJob(db, job.id)!;
  expect(indexed).toMatchObject({ id: job.id, project_root: first.repo, project_missing: false, state: "active" });
  expect(indexed.last_checkpoint).toMatchObject({ number: 2, kind: "manual", message: "Feature done", ref: `refs/relay/jobs/${job.id}/checkpoints/2` });
  expect(indexed.last_checkpoint!.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(indexed.current_worker).toMatchObject({ id: "w2", target: "codex:personal", state: "running", from_handoff: true });
  expect(getJob(db, jobId(second))!.last_checkpoint).toMatchObject({ number: 1, kind: "baseline" });

  expect(listWorkers(db, job.id).map((worker) => [worker.id, worker.state, worker.provider_session_id, worker.end_reason])).toEqual([
    ["w2", "running", null, null],
    ["w1", "ended", "session-1", "stopped_by_switch"],
  ]);

  expect(getAccount(db, "claude:work")!.availability).toEqual({
    status: "rate_limited", reason: "Claude Code reported a rate limit", retry_at: null,
    measured_at: "2026-10-07T14:02:11.402Z", source: "hook",
  });
  expect(getAccount(db, "codex:personal")).toMatchObject({
    availability: { status: "available", measured_at: "2026-10-07T14:30:02.000Z", source: "app_server" },
    usage: [
      { window: "five_hour", window_minutes: 300, used_percent: 9, resets_at: "2026-10-07T19:00:00.000Z", measured_at: "2026-10-07T14:30:02.000Z" },
      { window: "seven_day", window_minutes: 10080, used_percent: 30, resets_at: "2026-10-12T09:00:00.000Z", measured_at: "2026-10-07T14:30:02.000Z" },
    ],
  });
  expect(listAccounts(db).map((entry) => [entry.target, entry.configured, entry.availability.status])).toEqual([
    ["claude:home", true, "unknown"],
    ["claude:work", true, "rate_limited"],
    ["codex:personal", true, "available"],
  ]);
  db.close();
}, 30_000);

test("a project whose folder was deleted is marked missing and the others are indexed", async () => {
  const kept = await setUpJob("full", undefined, FAKE_SCANNER);
  scratches.push(kept);
  const gone = await setUpJob("full", undefined, FAKE_SCANNER);
  scratches.push(gone);
  const goneId = jobId(gone);
  rmSync(gone.repo, { recursive: true, force: true });

  const relayHome = tempRelayHome();
  const { db } = openDatabase(relayHome);
  expect(await buildIndex(db, relayHome, [], [kept.repo, gone.repo])).toBe(1);
  expect(getJob(db, jobId(kept))).not.toBeNull();
  expect(getJob(db, goneId)).toBeNull();
  expect(db.query("SELECT root_path, missing FROM projects ORDER BY missing").all()).toEqual([
    { root_path: kept.repo, missing: 0 },
    { root_path: gone.repo, missing: 1 },
  ]);
  db.close();
}, 30_000);
