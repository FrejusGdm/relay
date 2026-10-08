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

test("relay status --json is the same with and without the daemon, except daemon and generated_at", async () => {
  const scratch = await project();
  const daemon = spawnDaemon(scratch.relayHome);
  await waitForDaemon(scratch.relayHome);
  const online = await status(scratch, "--json");
  expect(await stopDaemon(daemon)).toBe(0);
  const offline = await status(scratch, "--json");
  expect([online.code, offline.code]).toEqual([0, 0]);
  const { daemon: first, generated_at: _a, ...withDaemon } = JSON.parse(online.stdout);
  const { daemon: second, generated_at: _b, ...withoutDaemon } = JSON.parse(offline.stdout);
  expect([first, second]).toEqual(["running", "not_running"]);
  expect(withoutDaemon).toEqual(withDaemon);
  expect(online.stdout.includes("Showing saved state")).toBe(false);
}, 30_000);
