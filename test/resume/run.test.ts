// relay run --resume-at-reset with the fake agents and a real daemon (add-resume-at-reset, task
// 3.1): the agent stops at a usage limit, relay run hands the wait to the daemon, the daemon resumes
// the same session on the same account after the reset, and relay run prints what happens and exits
// with the wait's exit code.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { stopStartedDaemon } from "../helpers/relay-home";
import { jobEvents, runFixture, spawnRelayRun, until, workers, type RunFixture } from "../run/helpers";

setDefaultTimeout(60_000);

const SESSION = "7c1e9a52-0b7e-4c1e-9f0a-3d5b2a1c4e8f";
// The daemon looks every 100 ms, resumes as soon as the reset time has passed and checks an
// unknown reset time every second.
const FAST = { RELAY_TEST_START_DAEMON: "1", RELAY_TEST_RESUME_TICK_MS: "100", RELAY_TEST_RESUME_MARGIN_MS: "0", RELAY_TEST_RESUME_CHECK_MS: "1000" };

let fixture: RunFixture | undefined;
afterEach(async () => {
  if (fixture !== undefined) {
    await stopStartedDaemon(fixture.relayHome);
    await fixture.cleanup();
  }
  fixture = undefined;
});

function inSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

test("a limit with a known reset time: relay waits, resumes the same session and finishes", async () => {
  const f = (fixture = await runFixture());
  const run = spawnRelayRun(f, ["claude:work", "--headless", "--resume-at-reset", "--prompt", "Fix the test."], {
    session_id: SESSION,
    turns: [{ steps: [{ say: "Working." }, { run: "bun test", exit_code: 1 }, { limit: { window: "five_hour", resets_at: inSeconds(3) } }] }],
    resumes: [{ turns: [{ steps: [{ write: "src/a.ts", content: "fixed\n" }, { say: "Done." }] }] }],
  }, FAST);
  const code = await run.exited;
  expect({ code, stderr: run.stderr() }).toMatchObject({ code: 0 });
  const out = run.stdout();
  if (process.env.SHOW_OUTPUT) console.log(out + "---\n" + run.stderr());
  expect(out).toContain("Waiting for claude:work's limit to reset at ");
  expect(out).toContain(`To cancel, run relay resume-at-reset off --job ${f.jobId}`);
  expect(out).toContain("Continuing session 7c1e9a52 on claude:work (resume 1).");
  expect(out).toContain("  changed src/a.ts");
  expect(out).toContain("The task ended normally after 1 resume.");
  const records = workers(f);
  expect(records).toHaveLength(2);
  expect(records[0]).toMatchObject({ account: "claude:work", resumed_from: SESSION, provider_session_id: SESSION, end_reason: "exited" });
  const types = jobEvents(f).map((event) => event.type).filter((type) => type.startsWith("resume_at_reset_"));
  expect(types).toEqual(["resume_at_reset_on", "resume_at_reset_waiting", "resume_at_reset_resumed", "resume_at_reset_ended"]);
  expect(jobEvents(f).find((event) => event.type === "resume_at_reset_ended")!.data).toMatchObject({ outcome: "finished", exit_code: 0, resumes: 1 });
  expect(existsSync(join(f.relayHome, "jobs", f.jobId, "resume-at-reset.json"))).toBe(false);
});
