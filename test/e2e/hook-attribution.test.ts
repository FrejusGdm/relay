// Task 9.2: relay run starts the daemon and a fake Claude Code agent with RELAY_HOME, RELAY_JOB,
// RELAY_TARGET and RELAY_WORKER in its environment. The agent's SessionStart and StopFailure hooks
// run relay hook, and the daemon attributes both events to the right worker, job and account.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { relayBin } from "../helpers/relay-bin";
import { stopStartedDaemon, testSocket } from "../helpers/relay-home";
import { relayIn, relayProcess, switchFixture, type SwitchFixture } from "../handoff/switch-helpers";
import { jobEvents, until, workers } from "../run/helpers";

setDefaultTimeout(120_000);

const SESSION = "7c1e9a52-0b7e-4c1e-9f0a-3d5b2a1c4e8f";
let fixture: SwitchFixture | undefined;
let bin: string | undefined;
afterEach(async () => {
  if (fixture !== undefined) await stopStartedDaemon(fixture.relayHome);
  await fixture?.cleanup();
  if (bin !== undefined) rmSync(dirname(bin), { recursive: true, force: true });
  fixture = undefined;
});

test("the daemon attributes SessionStart and StopFailure to the worker, the job and the account", async () => {
  const f = (fixture = await switchFixture());
  bin = relayBin();
  const env = { RELAY_BIN: bin, RELAY_TEST_START_DAEMON: "1" };
  expect((await relayIn(f, ["hooks", "install", "claude:work", "--yes"], { env })).code).toBe(0);
  const resets = new Date(Date.now() + 3 * 3600_000).toISOString();
  f.scenarios.set({ claude: { session_id: SESSION, turns: [{ steps: [{ say: "Working." }, { limit: { window: "five_hour", resets_at: resets } }] }] } });

  const run = relayProcess(f, ["run", "claude:work", "--headless", "--prompt", "Add auth."], env);
  expect(await run.exited).toBe(23);
  const worker = workers(f)[0]!;
  const hooks = () => jobEvents(f).filter((event) => event.type === "hook");
  await until(() => hooks().some((event) => event.data.event === "StopFailure"), 10_000);

  for (const name of ["SessionStart", "StopFailure"]) {
    expect(hooks().find((event) => event.data.event === name)?.data).toMatchObject({
      provider: "claude", event: name, relay_worker: worker.worker_id, worker_id: worker.worker_id, session_id: SESSION,
    });
  }
  expect(hooks().find((event) => event.data.event === "StopFailure")?.data.error).toBe("rate_limit");
  const fromHook = jobEvents(f).find((event) => event.type === "availability" && event.data.source === "hook");
  expect(fromHook?.data).toMatchObject({ worker_id: worker.worker_id, target: "claude:work", status: "rate_limited", retry_at: null });

  const get = async (path: string) => (await fetch(`http://relay${path}`, { unix: testSocket(f.relayHome) })).json() as Promise<Record<string, any>>;
  expect((await get(`/v1/jobs/${f.jobId}/workers`)).workers[0]).toMatchObject({ id: worker.worker_id, target: "claude:work", provider_session_id: SESSION });
  expect((await get("/v1/accounts/claude:work")).account.availability.status).toBe("rate_limited");
});
