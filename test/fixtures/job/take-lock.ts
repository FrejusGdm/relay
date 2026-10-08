// Takes the job lock from its own process, for the test of several processes recovering one stale
// lock. Arguments: RELAY_HOME, the job ID, the time to start (milliseconds since 1970) and how
// long to hold the lock. Prints "got" or "busy".
import { CommandError } from "../../../src/cli/errors";
import { takeJobLock } from "../../../src/job/lock";

const [relayHome, jobId, startAt, holdMs] = process.argv.slice(2) as [string, string, string, string];
await Bun.sleep(Math.max(0, Number(startAt) - Date.now()));
try {
  const release = takeJobLock(relayHome, jobId, "checkpoint");
  await Bun.sleep(Number(holdMs));
  release();
  console.log("got");
} catch (error) {
  if (!(error instanceof CommandError) || error.code !== 6) throw error;
  console.log("busy");
}
