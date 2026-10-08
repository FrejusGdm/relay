// Task 10.3: relay status without the daemon: the files, the spool and a read-only relay.db, the
// saved-state line, and no daemon started.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runRelay } from "../helpers/cli";
import { jobId, setUpJob, sha } from "../helpers/job";
import { removeTempRelayHomes, spawnDaemon, stopDaemon, waitForDaemon } from "../helpers/relay-home";
import type { ScratchRepo } from "../helpers/scratch-repo";

const scratches: ScratchRepo[] = [];
afterEach(() => {
  for (const scratch of scratches.splice(0).reverse()) scratch.cleanup();
  removeTempRelayHomes();
});

async function project(): Promise<ScratchRepo> {
  const scratch = await setUpJob();
  scratches.push(scratch);
  writeFileSync(join(scratch.relayHome, "config.toml"), '[accounts."claude:work"]\n[accounts."codex:personal"]\n', { mode: 0o600 });
  return scratch;
}

const status = (scratch: ScratchRepo, ...args: string[]) =>
  runRelay(["status", ...args], { cwd: scratch.repo, env: { RELAY_HOME: scratch.relayHome, TZ: "UTC" } });

test("with the daemon stopped, relay status shows the last checkpoint, ends with the saved-state line and starts nothing", async () => {
  const scratch = await project();
  const result = await status(scratch);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  const lines = result.stdout.split("\n");
  const commit = sha(scratch, `refs/relay/jobs/${jobId(scratch)}/checkpoints/1`).slice(0, 6);
  expect(lines[0]).toMatch(new RegExp(`^.+   job ${jobId(scratch)} · checkpoint ${commit} · (just now|\\d+ min ago)$`));
  expect(lines.slice(2)).toEqual([
    "claude:work      ────────────────   unknown · not measured",
    "codex:personal   ────────────────   unknown · not measured",
    "",
    "No agent is working on this job.",
    "",
    "Showing saved state. The relay daemon is not running.",
    "",
  ]);
  expect(existsSync(join(scratch.relayHome, "run"))).toBe(false);
}, 30_000);

test("a rate_limit hook spooled while the daemon was down shows as limit reached · reset unknown", async () => {
  const scratch = await project();
  mkdirSync(join(scratch.relayHome, "spool"), { mode: 0o700 });
  const line = {
    v: 1, received_at: new Date().toISOString(), provider: "claude", event: "StopFailure",
    relay_job: jobId(scratch), relay_target: "claude:work", relay_worker: null, profile: "default",
    fields: { session_id: "s1", hook_event_name: "StopFailure", error: "rate_limit" },
  };
  writeFileSync(join(scratch.relayHome, "spool", "hooks.jsonl"), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  const result = await status(scratch);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("claude:work      ────────────────   limit reached · reset unknown\n");
  const json = JSON.parse((await status(scratch, "--json")).stdout);
  expect(json.accounts[0]).toMatchObject({ target: "claude:work", availability: { status: "rate_limited", source: "hook", reason: "Claude Code reported a rate limit" } });
}, 30_000);

test("relay status --json is the same with and without the daemon, except daemon, saved_state and generated_at", async () => {
  const scratch = await project();
  const daemon = spawnDaemon(scratch.relayHome);
  await waitForDaemon(scratch.relayHome);
  const online = await status(scratch, "--json");
  expect(await stopDaemon(daemon)).toBe(0);
  const offline = await status(scratch, "--json");
  expect([online.code, offline.code]).toEqual([0, 0]);
  const { daemon: first, saved_state: savedFirst, generated_at: _a, ...withDaemon } = JSON.parse(online.stdout);
  const { daemon: second, saved_state: savedSecond, generated_at: _b, ...withoutDaemon } = JSON.parse(offline.stdout);
  expect([first, second, savedFirst, savedSecond]).toEqual(["running", "not_running", false, true]);
  expect(withoutDaemon).toEqual(withDaemon);
  expect(online.stdout.includes("Showing saved state")).toBe(false);
}, 30_000);

test("a named pipe in place of the spool does not block relay status", async () => {
  const scratch = await project();
  mkdirSync(join(scratch.relayHome, "spool"), { mode: 0o700 });
  expect(Bun.spawnSync(["mkfifo", join(scratch.relayHome, "spool", "hooks.jsonl")]).exitCode).toBe(0);
  expect(Bun.spawnSync(["mkfifo", join(scratch.relayHome, "spool", "hooks.123.draining")]).exitCode).toBe(0);
  const started = Date.now();
  const result = await status(scratch);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("claude:work      ────────────────   unknown · not measured\n");
  expect(Date.now() - started).toBeLessThan(10_000);
}, 30_000);

test("a daemon that has not indexed the project yet: the view is saved state, said in text and JSON", async () => {
  const scratch = await project();
  const runDir = join(scratch.relayHome, "run");
  mkdirSync(runDir, { mode: 0o700 });
  // A daemon that answers but knows no job yet.
  const server = Bun.serve({
    unix: join(runDir, "relay.sock"),
    fetch: () => Response.json({ error: { code: "job_not_found", message: "No job." } }, { status: 404 }),
  });
  try {
    const text = await status(scratch);
    expect(text.code).toBe(0);
    expect(text.stdout.endsWith("\nShowing saved state. The relay daemon has not read this project yet.\n")).toBe(true);
    const json = JSON.parse((await status(scratch, "--json")).stdout);
    expect(json).toMatchObject({ daemon: "running", saved_state: true, job: { id: jobId(scratch) } });
  } finally {
    server.stop(true);
  }
}, 30_000);
