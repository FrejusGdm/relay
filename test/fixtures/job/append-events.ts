// Appends events to a job from its own process, for the test of two writers at once.
// Arguments: the worktree root, RELAY_HOME, the job ID, the number of events and a label.
import { appendEvent } from "../../../src/job/events";

const [worktreeRoot, relayHome, id, count, label] = process.argv.slice(2) as [string, string, string, string, string];
for (let i = 0; i < Number(count); i++) {
  await appendEvent({ id, worktreeRoot, relayHome }, "test_event", { writer: label, n: i });
}
