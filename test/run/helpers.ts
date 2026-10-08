// Shared steps for the relay run tests: a scratch repository with a job and two accounts, relay run
// in the same process or as its own process, and readers for the job's events and worker records.
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startAccountRecord } from "../../src/accounts/record";
import { policyOf } from "../../src/policies/load";
import { readWorkerRecords, type WorkerRecord } from "../../src/run/worker-record";
import type { Scenario } from "../fakes/scenario";
import { MAIN, runRelayInProcess, type RelayResult } from "../helpers/cli";
import { fakeEnv } from "../helpers/fake-programs";
import { events, FAKE_SCANNER, jobId, setUpJob } from "../helpers/job";
import type { ScratchRepo } from "../helpers/scratch-repo";

export const ACCOUNTS = '[accounts."claude:work"]\n\n[accounts."codex:personal"]\n';

export type FakeScenario = Omit<Scenario, "version" | "turns"> & { turns?: Scenario["turns"] };

export interface RunFixture {
  scratch: ScratchRepo;
  relayHome: string;
  jobId: string;
  cleanup(): Promise<void>;
}

// relay run processes a test started that may still run when the test ends, for example after a
// failed expectation.
const running = new Set<ChildProcess>();

// SIGTERM makes relay stop its agent, which runs in its own process group, before relay exits.
async function stopRunning(): Promise<void> {
  for (const child of running) {
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid!, "SIGTERM"); } catch { /* already gone */ }
      const ended = await Promise.race([new Promise((done) => child.once("close", () => done(true))), Bun.sleep(5000).then(() => false)]);
      if (!ended) try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
    }
    running.delete(child);
  }
}

// A job in a scratch repository, with config.toml holding `config` and account records that say the
// person has seen the current policies, so no policy notice is printed.
export async function runFixture(config = ACCOUNTS, kind: "full" | "empty" = "full"): Promise<RunFixture> {
  // relay run never scans for secrets, so the job is set up with the fake scanner.
  const scratch = await setUpJob(kind, undefined, FAKE_SCANNER);
  writeFileSync(join(scratch.relayHome, "config.toml"), config, { mode: 0o600 });
  for (const [provider, name] of [["claude", "work"], ["codex", "personal"]] as const) {
    startAccountRecord(scratch.relayHome, { id: `${provider}:${name}`, provider, name }, { policy_checked_on_seen: policyOf(provider).checkedOn });
  }
  return {
    scratch, relayHome: scratch.relayHome, jobId: jobId(scratch),
    cleanup: async () => {
      await stopRunning();
      scratch.cleanup();
    },
  };
}

export function steps(...list: Scenario["turns"][number]["steps"]): FakeScenario {
  return { turns: [{ steps: list }] };
}

// relay run in the test process, with the fake programs.
export function relayRun(
  fixture: RunFixture, args: string[], scenario: FakeScenario = {}, env: Record<string, string> = {},
): Promise<RelayResult> {
  return runRelayInProcess(["run", ...args], {
    cwd: fixture.scratch.repo, relayHome: fixture.relayHome, env: { ...fakeEnv(scenario), ...env },
  });
}

// relay run as its own process, leading its own process group so that a test can send signals to
// the group as a terminal would. Standard input is a pipe the test writes to.
export function spawnRelayRun(fixture: RunFixture, args: string[], scenario: FakeScenario = {}, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["--no-env-file", MAIN, "run", ...args], {
    cwd: fixture.scratch.repo, detached: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, RELAY_HOME: fixture.relayHome, ...fakeEnv(scenario), ...env },
  });
  running.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<number | null>((done) => child.once("close", (code) => done(code)));
  return { child, exited, stdout: () => stdout, stderr: () => stderr };
}

export async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("The condition did not become true in time.");
    await Bun.sleep(20);
  }
}

export function jobEvents(fixture: RunFixture): { type: string; data: Record<string, unknown> }[] {
  return events(fixture.scratch);
}

export function workers(fixture: RunFixture): WorkerRecord[] {
  return readWorkerRecords(fixture.relayHome, fixture.jobId);
}

// A reset time a few hours from now, on a whole minute.
export function resetTime(hours = 3): Date {
  const time = new Date(Date.now() + hours * 3600_000);
  time.setUTCSeconds(0, 0);
  return time;
}
