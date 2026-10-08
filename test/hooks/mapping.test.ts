// Task 8.2: what the daemon does with a hook event (design.md decision 18): the availability
// table, the events that leave availability alone, finding the worker, job and account, the
// SessionStart session ID, and the checks on POST /v1/hooks/{provider}/{event}. The daemon's
// parts run in this process on a scratch project: the index, the event stream, the follower and
// the hook queue.
import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readAvailability } from "../../src/accounts/availability";
import { createRouter } from "../../src/api/router";
import { hookRoutes } from "../../src/api/routes/hooks";
import { startApiServer } from "../../src/api/server";
import { EventStream } from "../../src/api/sse";
import type { Account } from "../../src/core/config/types";
import type { Logger } from "../../src/core/log";
import { Follower } from "../../src/daemon/follow";
import { spoolLine, type SpoolLine } from "../../src/hooks/fields";
import { HookQueue } from "../../src/hooks/mapping";
import { appendEvent, type JobRef } from "../../src/job/events";
import { openDatabase } from "../../src/state/db";
import { buildIndex } from "../../src/state/index-builder";
import { readProjects } from "../../src/state/projects-list";
import { getAccount, getWorker } from "../../src/state/queries";
import { events, eventsText, jobId, setUpJob } from "../helpers/job";
import { removeTempRelayHomes, tempRelayHome } from "../helpers/relay-home";
import type { ScratchRepo } from "../helpers/scratch-repo";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "hooks");
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Record<string, unknown>;
const WORKER = "a41c7b09";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  removeTempRelayHomes();
});

function account(id: `${"claude" | "codex"}:${string}`, profileDir: string): Account {
  const [provider, name] = id.split(":") as ["claude" | "codex", string];
  return { id, provider, name, profileDir, profileDirIsDefault: false, credentialEnv: [], kind: null };
}

// A logger that keeps every line, so tests can check what reached the log.
function memoryLog(lines: string[]): Logger {
  const write = (msg: string, fields?: unknown) => lines.push(JSON.stringify({ msg, ...(fields as object) }));
  return { file: "", writing: true, setLevel() {}, debug: write, info: write, warn: write, error: write };
}

interface Daemon {
  scratch: ScratchRepo;
  db: Database;
  job: JobRef;
  homedir: string;
  queue: HookQueue;
  logLines: string[];
  // Builds the spool line relay hook would send for this input and environment, and processes it.
  send(provider: "claude" | "codex", event: string, input: Record<string, unknown>, env?: Record<string, string>): Promise<SpoolLine>;
  availability(target: string): unknown;
  streamTypes(): string[];
}

// claude:work and codex:personal have their own profile folders; claude:home uses ~/.claude.
async function daemon(): Promise<Daemon> {
  const scratch = await setUpJob();
  cleanups.push(() => scratch.cleanup());
  const homedir = scratch.home;
  const accounts = [
    account("claude:work", "/srv/profiles/claude-work"),
    account("claude:home", resolve(homedir, ".claude")),
    account("codex:personal", "/srv/profiles/codex-personal"),
  ];
  const { db } = openDatabase(scratch.relayHome);
  cleanups.push(() => db.close());
  await buildIndex(db, scratch.relayHome, accounts, readProjects(scratch.relayHome));
  const stream = new EventStream(db);
  const logLines: string[] = [];
  const log = memoryLog(logLines);
  const follower = new Follower({ db, relayHome: scratch.relayHome, stream, log });
  cleanups.push(() => follower.stop());
  const queue = new HookQueue({ db, relayHome: scratch.relayHome, homedir, stream, log, catchUp: () => follower.check() });
  return {
    scratch,
    db,
    job: { id: jobId(scratch), worktreeRoot: scratch.repo, relayHome: scratch.relayHome },
    homedir,
    queue,
    logLines,
    send: async (provider, event, input, env = {}) => {
      const line = spoolLine(provider, event, input, env, new Date());
      expect(queue.offer(line)).toBe(true);
      await queue.idle();
      return line;
    },
    availability: (target) => getAccount(db, target)?.availability,
    streamTypes: () => db.query<{ type: string }, []>("SELECT type FROM stream_events ORDER BY seq").all().map((row) => row.type),
  };
}

const relayEnv = (d: Daemon, target: string) => ({ RELAY_JOB: d.job.id, RELAY_TARGET: target });

test("every row of the availability table, read from the error field", async () => {
  const d = await daemon();
  const rows: [string, "claude" | "codex", string, string, string, string][] = [
    ["claude-stop-failure-rate-limit.json", "claude", "StopFailure", "claude:work", "rate_limited", "Claude Code reported a rate limit"],
    ["claude-stop-failure-billing-error.json", "claude", "StopFailure", "claude:work", "unavailable", "Claude Code reported a billing problem"],
    ["claude-stop-failure-authentication-failed.json", "claude", "StopFailure", "claude:home", "unavailable", "Claude Code is signed out of this account"],
    ["claude-stop-failure-oauth-org-not-allowed.json", "claude", "StopFailure", "claude:work", "unavailable", "This organization does not allow this login"],
    ["claude-stop-failure-account-on-hold.json", "claude", "StopFailure", "claude:work", "unavailable", "Claude Code reported that the account is on hold"],
    ["claude-stop.json", "claude", "Stop", "claude:work", "available", "The last turn finished normally"],
    ["codex-stop.json", "codex", "Stop", "codex:personal", "available", "The last turn finished normally"],
  ];
  for (const [name, provider, event, target, status, reason] of rows) {
    const line = await d.send(provider, event, fixture(name), relayEnv(d, target));
    expect({ name, availability: d.availability(target) }).toEqual({
      name,
      availability: { status, reason, retry_at: null, measured_at: line.received_at, source: "hook" },
    });
    const [hookEvent, availabilityEvent] = events(d.scratch).slice(-2);
    expect(hookEvent).toMatchObject({ type: "hook", data: { provider, event } });
    expect(availabilityEvent).toMatchObject({ type: "availability", data: { target, status, reason, retry_at: null, source: "hook", windows: [] } });
    const [providerName, accountName] = target.split(":") as ["claude" | "codex", string];
    expect(readAvailability(d.scratch.relayHome, { id: `${providerName}:${accountName}`, provider: providerName, name: accountName })).toMatchObject({
      state: status,
      detail: reason,
      source: "hook",
    });
  }
}, 30_000);

test("quota_auto_resume_fired sets available; server_error and overloaded leave availability as it was", async () => {
  const d = await daemon();
  await d.send("claude", "StopFailure", fixture("claude-stop-failure-rate-limit.json"), relayEnv(d, "claude:work"));
  for (const name of ["claude-stop-failure-server-error.json", "claude-stop-failure-overloaded.json"]) {
    await d.send("claude", "StopFailure", fixture(name), relayEnv(d, "claude:work"));
    expect(d.availability("claude:work")).toMatchObject({ status: "rate_limited", reason: "Claude Code reported a rate limit" });
    expect(events(d.scratch).at(-1)).toMatchObject({ type: "hook", data: { event: "StopFailure", error: fixture(name).error } });
  }
  await d.send("claude", "Notification", fixture("claude-notification-quota-resume.json"), relayEnv(d, "claude:work"));
  expect(d.availability("claude:work")).toMatchObject({ status: "available", reason: "Claude Code continued after its reset.", source: "hook" });
}, 30_000);

test("without RELAY_TARGET the account comes from the profile folder, and default means ~/.claude", async () => {
  const d = await daemon();
  await d.send("claude", "StopFailure", fixture("claude-stop-failure-rate-limit.json"), { CLAUDE_CONFIG_DIR: "/srv/profiles/claude-work" });
  expect(d.availability("claude:work")).toMatchObject({ status: "rate_limited", source: "hook" });
  expect(d.availability("claude:home")).toMatchObject({ status: "unknown" });
  await d.send("claude", "StopFailure", fixture("claude-stop-failure-billing-error.json"), {});
  expect(d.availability("claude:home")).toMatchObject({ status: "unavailable", reason: "Claude Code reported a billing problem" });
  // Neither event names a job, and /srv/app is no project, so both went to the index and the
  // event stream directly.
  expect(d.streamTypes().filter((type) => type === "hook" || type === "availability")).toEqual(["hook", "availability", "hook", "availability"]);
  expect(eventsText(d.scratch)).not.toContain('"type":"hook"');
}, 30_000);

test("an event with no account changes no availability, and neither does an account missing from config.toml", async () => {
  const d = await daemon();
  const before = ["claude:work", "claude:home", "codex:personal"].map((target) => d.availability(target));
  await d.send("claude", "StopFailure", fixture("claude-stop-failure-rate-limit.json"), { CLAUDE_CONFIG_DIR: "/srv/profiles/someone-else" });
  await d.send("claude", "StopFailure", fixture("claude-stop-failure-rate-limit.json"), { RELAY_TARGET: "claude:ghost" });
  await d.send("codex", "Stop", fixture("codex-stop.json"), { RELAY_TARGET: "claude:work" });
  expect(["claude:work", "claude:home", "codex:personal"].map((target) => d.availability(target))).toEqual(before);
  expect(getAccount(d.db, "claude:ghost")).toBeNull();
  expect(existsSync(join(d.scratch.relayHome, "accounts", "claude-ghost"))).toBe(false);
  expect(d.streamTypes()).not.toContain("availability");
}, 30_000);

test("SessionStart sets the provider session ID of the worker named by RELAY_WORKER, once", async () => {
  const d = await daemon();
  await appendEvent(d.job, "worker_started", {
    worker_id: WORKER, target: "claude:work", mode: "interactive", pid: process.pid, provider_session_id: null, from_handoff: false,
  });
  const input = fixture("claude-session-start.json");
  await d.send("claude", "SessionStart", input, { ...relayEnv(d, "claude:work"), RELAY_WORKER: WORKER });
  expect(getWorker(d.db, WORKER)?.provider_session_id).toBe(input.session_id as string);
  expect(events(d.scratch).filter((event) => event.type === "worker_session_identified")).toMatchObject([
    { data: { worker_id: WORKER, provider_session_id: input.session_id } },
  ]);
  await d.send("claude", "SessionStart", { ...input, session_id: "11111111-2222-4333-8444-555555555555" }, { ...relayEnv(d, "claude:work"), RELAY_WORKER: WORKER });
  expect(getWorker(d.db, WORKER)?.provider_session_id).toBe(input.session_id as string);

  // A later event from that session, with no relay variables, belongs to the same worker, job and
  // account.
  await d.send("claude", "StopFailure", fixture("claude-stop-failure-rate-limit.json"), {});
  expect(events(d.scratch).at(-1)).toMatchObject({ type: "availability", data: { worker_id: WORKER, target: "claude:work", status: "rate_limited" } });
}, 30_000);

test("a session ID that is not a UUID is not recorded", async () => {
  const d = await daemon();
  await appendEvent(d.job, "worker_started", {
    worker_id: WORKER, target: "claude:work", mode: "interactive", pid: process.pid, provider_session_id: null, from_handoff: false,
  });
  await d.send("claude", "SessionStart", { ...fixture("claude-session-start.json"), session_id: "--resume; rm -rf ~" }, { ...relayEnv(d, "claude:work"), RELAY_WORKER: WORKER });
  expect(getWorker(d.db, WORKER)?.provider_session_id).toBeNull();
}, 30_000);

test("an agent started outside relay: the event goes to the job whose project holds cwd, and no availability changes", async () => {
  const d = await daemon();
  const input = { ...fixture("claude-stop-failure-rate-limit.json"), cwd: join(d.scratch.repo, "src") };
  await d.send("claude", "StopFailure", input, { CLAUDE_CONFIG_DIR: "/srv/profiles/someone-else" });
  expect(events(d.scratch).at(-1)).toMatchObject({ type: "hook", data: { provider: "claude", event: "StopFailure", error: "rate_limit" } });
  expect(d.availability("claude:work")).toMatchObject({ status: "unknown" });
}, 30_000);

test("tool_input and the other dropped fields reach neither events.jsonl, the database nor the log", async () => {
  const d = await daemon();
  const router = createRouter(hookRoutes(d.queue));
  const line = { ...spoolLine("claude", "PostToolUse", {}, relayEnv(d, "claude:work"), new Date()) } as Record<string, unknown>;
  const forged = { ...line, extra: "dropped-top-level", fields: fixture("claude-post-tool-use.json") };
  const response = await router.handle(new Request("http://relay/v1/hooks/claude/PostToolUse", { method: "POST", body: JSON.stringify(forged) }));
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ accepted: true });
  await d.queue.idle();
  expect(events(d.scratch).at(-1)).toMatchObject({ type: "hook", data: { event: "PostToolUse", hook_event_name: "PostToolUse" } });
  const stored = [
    eventsText(d.scratch),
    JSON.stringify(d.db.query("SELECT * FROM stream_events").all()),
    d.logLines.join("\n"),
  ].join("\n");
  for (const dropped of ["tool_input", "tool_response", "transcript_path", "cat .env.local", "PORT=3000", "dropped-top-level"]) {
    expect(stored).not.toContain(dropped);
  }
}, 30_000);

test("POST /v1/hooks refuses paths and bodies that are not hook events, and a full queue", async () => {
  const d = await daemon();
  const router = createRouter(hookRoutes(d.queue));
  const good = spoolLine("claude", "Stop", fixture("claude-stop.json"), relayEnv(d, "claude:work"), new Date());
  const post = (path: string, body: unknown) =>
    router.handle(new Request(`http://relay${path}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));
  const refused: [string, unknown][] = [
    ["/v1/hooks/cursor/Stop", { ...good, provider: "cursor" }],
    ["/v1/hooks/claude/Stop%0Aevent:%20shutdown", good],
    ["/v1/hooks/claude/Stop", "not json"],
    ["/v1/hooks/claude/StopFailure", good],
    ["/v1/hooks/codex/Stop", good],
    ["/v1/hooks/claude/Stop", { ...good, relay_job: "../../etc" }],
    ["/v1/hooks/claude/Stop", { ...good, relay_worker: "a41c7b09/../x" }],
    ["/v1/hooks/claude/Stop", { ...good, relay_target: "codex:personal" }],
    ["/v1/hooks/claude/Stop", { ...good, profile: "relative/folder" }],
    ["/v1/hooks/claude/Stop", { ...good, received_at: new Date(Date.now() + 3_600_000).toISOString() }],
    ["/v1/hooks/claude/Stop", { ...good, fields: ["not", "an", "object"] }],
    ["/v1/hooks/claude/Stop", { ...good, v: 2 }],
  ];
  for (const [path, body] of refused) {
    const response = await post(path, body);
    expect({ path, status: response.status, code: ((await response.json()) as { error: { code: string } }).error.code }).toEqual({
      path,
      status: 400,
      code: "bad_request",
    });
  }
  await d.queue.idle();
  expect(eventsText(d.scratch)).not.toContain('"type":"hook"');

  const full = createRouter(hookRoutes(new HookQueue({ db: d.db, relayHome: d.scratch.relayHome, homedir: d.homedir, stream: new EventStream(d.db), log: memoryLog([]), catchUp: async () => {} }, 0)));
  const response = await full.handle(new Request("http://relay/v1/hooks/claude/Stop", { method: "POST", body: JSON.stringify(good) }));
  expect(response.status).toBe(503);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe("hook_queue_full");
}, 30_000);

test("a hook from another user is refused at the socket before it is read", async () => {
  const d = await daemon();
  const relayHome = tempRelayHome();
  const socketPath = join(relayHome, "relay.sock");
  const logLines: string[] = [];
  const server = startApiServer({ socketPath, router: createRouter(hookRoutes(d.queue)), log: memoryLog(logLines), allowedUid: process.getuid!() + 1 });
  const line = spoolLine("claude", "StopFailure", fixture("claude-stop-failure-rate-limit.json"), relayEnv(d, "claude:work"), new Date());
  const answer = await fetch("http://relay/v1/hooks/claude/StopFailure", { unix: socketPath, method: "POST", body: JSON.stringify(line) }).then(
    (response) => response.status,
    () => "no answer",
  );
  await server.stop(0);
  await d.queue.idle();
  expect(answer).toBe("no answer");
  expect(logLines.some((text) => text.includes("peer_rejected"))).toBe(true);
  expect(d.availability("claude:work")).toMatchObject({ status: "unknown" });
}, 30_000);
