// Stopping the current agent through its adapter (task 5.1): relay switch reaches the relay run
// that holds the agent, which stops it, records how, and puts the terminal back.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { writeWorkerRecord } from "../../src/run/worker-record";
import { jobEvents, until, workers } from "../run/helpers";
import { relayIn, relayProcess, relayTerminal, switchFixture, type SwitchFixture } from "./switch-helpers";

setDefaultTimeout(60_000);

let fixture: SwitchFixture;
afterEach(() => fixture?.cleanup());

const working = { turns: [{ steps: [{ write: "src/work.ts", content: "work\n" }, { say: "Working." }, { hang: true as const }] }] };

function endedEvent(workerId: string) {
  return jobEvents(fixture).find((event) => event.type === "worker_ended" && event.data.worker_id === workerId)?.data;
}

test("an interactive Claude Code stops on SIGTERM", async () => {
  fixture = await switchFixture();
  fixture.scenarios.set({ claude: working });
  const run = relayProcess(fixture, ["run", "claude:work"]);
  await until(() => run.stdout().includes("Working."));
  const result = await relayIn(fixture, ["switch", "codex:personal", "--no-start", "--no-summary"]);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(result.stdout).toStartWith("Stopping Claude Code · work\nSaved checkpoint ");
  expect(await run.exited).toBe(0);
  const claude = workers(fixture).find((record) => record.account === "claude:work")!;
  expect(endedEvent(claude.worker_id)).toMatchObject({ end_reason: "stopped_by_switch", stop_how: "terminated", exit_code: 143 });
});

test("an agent that ignores SIGTERM is killed after handoff.stop_timeout_seconds", async () => {
  fixture = await switchFixture();
  fixture.scenarios.set({ claude: { turns: [{ steps: [{ ignore_sigterm: true }, { say: "Working." }, { hang: true }] }] } });
  const run = relayProcess(fixture, ["run", "claude:work"]);
  await until(() => run.stdout().includes("Working."));
  const started = Date.now();
  const result = await relayIn(fixture, ["switch", "codex:personal", "--no-start", "--no-summary"]);
  expect(result.code).toBe(0);
  expect(Date.now() - started).toBeGreaterThan(4500);
  await run.exited;
  const claude = workers(fixture).find((record) => record.account === "claude:work")!;
  expect(endedEvent(claude.worker_id)).toMatchObject({ end_reason: "stopped_by_switch", stop_how: "killed", signal: "SIGKILL" });
});

test("an agent whose relay run is gone is not signalled: exit 33", async () => {
  fixture = await switchFixture();
  fixture.scenarios.set({ claude: { turns: [{ steps: [{ say: "Done." }] }] } });
  expect((await relayIn(fixture, ["run", "claude:work", "--headless", "--prompt", "Go."])).code).toBe(0);
  // A worker record whose process still runs, as a relay run that was killed would leave it.
  const orphan = Bun.spawn(["sleep", "60"]);
  await Bun.sleep(100);
  try {
    const record = workers(fixture)[0]!;
    writeWorkerRecord(fixture.relayHome, { ...record, pid: orphan.pid, started_at: new Date().toISOString(), ended_at: null, end_reason: null, exit_code: null });
    const result = await relayIn(fixture, ["switch", "codex:personal", "--no-start"]);
    expect(result).toEqual({
      code: 33, stdout: "",
      stderr: `relay: Claude Code (process ${orphan.pid}) is still running, but the relay run that started it is gone. Stop it yourself, then try again.\n`,
    });
    expect(orphan.exitCode).toBeNull();
  } finally {
    orphan.kill();
  }
});

test("the terminal of relay run is restored before relay prints its next line", async () => {
  fixture = await switchFixture();
  fixture.scenarios.set({ claude: working });
  const run = relayTerminal(fixture, ["run", "claude:work"]);
  await until(() => run.output().includes("Working."));
  const result = await relayIn(fixture, ["switch", "codex:personal", "--no-start", "--no-summary"]);
  expect(result.code).toBe(0);
  await run.child.exited;
  const output = run.output();
  const restore = output.indexOf("\x1b[?1049l\x1b[?25h\x1b[0m", output.indexOf("Stopping Claude Code · work"));
  expect(restore).toBeGreaterThan(-1);
  expect(restore).toBeLessThan(output.indexOf("Saved checkpoint"));
});
