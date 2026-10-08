// Task 7.2: POST /v1/jobs/{job}/switch runs the switch engine of add-relay-switch without a
// terminal. A headless next agent runs as a child of the daemon and is listed in agents_running;
// relay daemon stop refuses while it runs, and --force stops it with a worker_ended event whose
// end_reason is relay_stopped. A job whose agents run in a terminal, and a new account without
// confirm_new_provider, are refused before anything is stopped. With the fake agents only.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type { Subprocess } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { processExists } from "../../src/state/queries";
import { runRelay } from "../helpers/cli";
import { removeTempRelayHomes, spawnDaemon, stopDaemon, testSocket, waitForDaemon } from "../helpers/relay-home";
import { relayIn, relayProcess, relayTerminal, Scenarios, switchFixture, type SwitchFixture } from "../handoff/switch-helpers";
import { jobEvents, until, workers } from "../run/helpers";

setDefaultTimeout(120_000);

let fixture: SwitchFixture | undefined;
let daemon: Subprocess | undefined;
afterEach(async () => {
  if (daemon !== undefined && daemon.exitCode === null) await stopDaemon(daemon);
  daemon = undefined;
  await fixture?.cleanup();
  fixture = undefined;
  removeTempRelayHomes();
});

async function startDaemon(f: SwitchFixture): Promise<void> {
  daemon = spawnDaemon(f.relayHome, f.env);
  await waitForDaemon(f.relayHome);
}

async function request(f: SwitchFixture, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`http://relay${path}`, {
    unix: testSocket(f.relayHome), method,
    ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) } : {}),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const parentOf = (pid: number) => Number(Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)], { stdout: "pipe" }).stdout.toString().trim());

// A headless Claude Code worker that ran under relay run and finished.
async function claudeWorked(f: SwitchFixture): Promise<void> {
  f.scenarios.set({ claude: { turns: [{ steps: [{ write: "src/auth.ts", content: "export const auth = 1;\n" }, { say: "Done." }] }] } });
  expect((await relayIn(f, ["run", "claude:work", "--headless", "--prompt", "Add auth."])).code).toBe(0);
}

test("a switch to a headless target returns 200 with a running worker; relay daemon stop refuses until --force", async () => {
  const f = (fixture = await switchFixture());
  await claudeWorked(f);
  f.scenarios.set({ claude: Scenarios.fixture("claude-answers-notes.json"), codex: Scenarios.fixture("codex-starts.json") });
  await startDaemon(f);

  const { status, body } = await request(f, "POST", `/v1/jobs/${f.jobId}/switch`, { target: "codex:personal" });
  expect(status).toBe(200);
  expect(body.worker).toMatchObject({ job_id: f.jobId, target: "codex:personal", mode: "headless", state: "running", from_handoff: true, ended_at: null });
  expect(body.handoff).toMatchObject({ handoff_id: 1, outcome: "started", to_worker_id: body.worker.id });
  const worker = body.worker as { id: string; pid: number };
  expect(parentOf(worker.pid)).toBe(daemon!.pid);
  expect(existsSync(join(f.relayHome, "logs", "workers", `${f.jobId}-${worker.id}.log`))).toBe(true);
  expect((await request(f, "GET", "/v1/version")).body.agents_running).toEqual([{ worker: worker.id, target: "codex:personal", job: f.jobId }]);

  const env = { RELAY_HOME: f.relayHome };
  expect(await runRelay(["daemon", "stop"], { env })).toEqual({
    code: 1,
    stdout: "",
    stderr: `relay daemon is running 1 agent (codex:personal on job ${f.jobId}). Stopping the daemon stops it too. Run relay daemon stop --force to continue.\n`,
  });
  expect(processExists(worker.pid)).toBe(true);
  expect(await runRelay(["daemon", "stop", "--force"], { env })).toEqual({ code: 0, stdout: "relay daemon stopped\n", stderr: "" });
  expect(await daemon!.exited).toBe(0);
  expect(processExists(worker.pid)).toBe(false);
  const ended = jobEvents(f).find((event) => event.type === "worker_ended" && event.data.worker_id === worker.id);
  expect(ended?.data.end_reason).toBe("relay_stopped");
});

test("a job whose agents run in a terminal gets 409 interactive_start_required, and its agent keeps running", async () => {
  const f = (fixture = await switchFixture());
  f.scenarios.set({ claude: { turns: [{ steps: [{ say: "Working on it." }, { hang: true }] }] } });
  const a = relayTerminal(f, ["run", "claude:work"]);
  try {
    await until(() => a.output().includes("Working on it."), 30_000);
    await startDaemon(f);
    expect(await request(f, "POST", `/v1/jobs/${f.jobId}/switch`, { target: "codex:personal" })).toEqual({
      status: 409,
      body: { error: { code: "interactive_start_required", message: "This switch needs a terminal. Run relay switch codex:personal in the project." } },
    });
    const claude = workers(f)[0]!;
    expect(claude.ended_at).toBeNull();
    expect(processExists(claude.pid!)).toBe(true);
    expect(jobEvents(f).some((event) => event.type === "worker_ended" || event.type === "handoff")).toBe(false);
  } finally {
    a.child.kill("SIGTERM");
    await a.child.exited;
  }
});

test("a new provider needs confirm_new_provider; the confirmed switch goes to the relay run that holds the agent", async () => {
  const f = (fixture = await switchFixture({ allow: ["claude:work"] }));
  f.scenarios.set({ claude: { turns: [{ steps: [{ say: "Working." }, { hang: true }] }] } });
  const run = relayProcess(f, ["run", "claude:work", "--headless", "--prompt", "Add auth."]);
  await until(() => jobEvents(f).some((event) => event.type === "worker_session_identified"), 30_000);
  await startDaemon(f);
  const config = readFileSync(join(f.relayHome, "config.toml"), "utf8");

  expect(await request(f, "POST", `/v1/jobs/${f.jobId}/switch`, { target: "codex:personal" })).toEqual({
    status: 409,
    body: { error: { code: "confirmation_required", message: "This sends the repository and the job notes to OpenAI through the account codex:personal. Continue?" } },
  });
  expect(jobEvents(f).some((event) => event.type === "worker_ended")).toBe(false);
  expect(processExists(workers(f)[0]!.pid!)).toBe(true);
  expect(readFileSync(join(f.relayHome, "config.toml"), "utf8")).toBe(config);

  f.scenarios.set({ claude: Scenarios.fixture("claude-answers-notes.json"), codex: Scenarios.fixture("codex-starts.json") });
  const { status, body } = await request(f, "POST", `/v1/jobs/${f.jobId}/switch`, { target: "codex:personal", confirm_new_provider: true });
  expect({ status, body }).toMatchObject({ status: 200 });
  expect(body.worker).toMatchObject({ target: "codex:personal", mode: "headless", state: "running" });
  // The relay run that held Claude Code ran the switch and runs Codex; the daemon runs no agent.
  expect(parentOf(body.worker.pid)).toBe(run.child.pid!);
  expect((await request(f, "GET", "/v1/version")).body.agents_running).toEqual([]);
  expect(jobEvents(f).find((event) => event.type === "provider_allowed")?.data).toMatchObject({ account: "codex:personal", how: "api" });
  expect(readFileSync(join(f.relayHome, "config.toml"), "utf8")).toContain('allow = ["claude:work", "codex:personal"]');
});

test("an account that is not configured, and a target that is not an account name, are refused", async () => {
  const f = (fixture = await switchFixture());
  await claudeWorked(f);
  await startDaemon(f);
  expect(await request(f, "POST", `/v1/jobs/${f.jobId}/switch`, { target: "codex:work" })).toEqual({
    status: 404, body: { error: { code: "target_not_found", message: "No account named codex:work in config.toml." } },
  });
  expect(await request(f, "POST", `/v1/jobs/${f.jobId}/switch`, { target: "codex personal" })).toEqual({
    status: 400, body: { error: { code: "invalid_target", message: "codex personal is not an account name. Use provider:account, for example codex:personal." } },
  });
  expect((await request(f, "POST", `/v1/jobs/${f.jobId}/switch`, { target: "codex:personal", command: "rm -rf /" })).body.error.code).toBe("bad_request");
});
