// The events of a handoff (task 5.4): the data fields of design decision 20, and no text an agent
// wrote, no command output and no environment value.
import { expect, test } from "bun:test";
import type { CheckResult } from "../../src/handoff/checks";
import {
  checkRunEvent, handoffEvent, handoffFailedEvent, handoffNotesEvent, providerAllowedEvent, verificationEvent,
} from "../../src/handoff/events";

const check: CheckResult = {
  command: "bun test", outcome: "failed", exitCode: 1, signal: null, seconds: 41, counts: { passed: 231, failed: 1, skipped: 0 },
  logPath: "/r/logs/checks/3f9a2c1d-h3-1.log", excerpt: ["OUTPUT-MARKER"], changedFiles: [], timeoutSeconds: 600, ranAt: new Date(),
};

test("each event has exactly the fields of design decision 20", () => {
  expect(Object.keys(handoffNotesEvent({ handoff: 3, fromWorkerId: "5d2e8f01", outcome: "received", reason: null, seconds: 4, characters: 900, invisibleRemoved: 0 }).data))
    .toEqual(["handoff", "from_worker_id", "outcome", "reason", "seconds", "characters", "invisible_removed"]);
  expect(checkRunEvent(3, check, "/r")).toEqual({
    type: "check_run",
    data: { handoff: 3, command: "bun test", outcome: "failed", exit_code: 1, signal: null, seconds: 41, passed: 231, failed: 1, skipped: 0, log: "logs/checks/3f9a2c1d-h3-1.log" },
  });
  expect(Object.keys(verificationEvent(3, "5d2e8f01", { rows: 5, yes: 3, no: 1, unclear: 1 }).data)).toEqual(["handoff", "worker_id", "rows", "yes", "no", "unclear"]);
  expect(providerAllowedEvent({ account: "codex:personal", company: "OpenAI", how: "terminal" }).data).toEqual({ account: "codex:personal", company: "OpenAI", how: "terminal" });
  const handoff = handoffEvent({
    number: 3, fromWorkerId: "5d2e8f01", fromTarget: "claude:personal", toTarget: "codex:personal", toWorkerId: null,
    checkpointNumber: 7, checkpointCommit: "912ec1f", handoffRef: "refs/relay/jobs/3f9a2c1d/handoffs/3", notesSource: "agent",
    notesReason: null, claimsCount: 3,
    mismatches: [{ kind: "check", claim: "notes say `bun test` passes", found: "231 passed, 1 failed (exit code 1)", sentence: "The notes say ..." }],
    checks: [check], instructionFilesChanged: [], confirmations: [], invisibleRemoved: 0, promptPath: "/r/jobs/3f9a2c1d/handoffs/3/prompt.md",
  });
  expect(Object.keys(handoff.data)).toEqual([
    "number", "from_worker_id", "from_target", "to_target", "to_worker_id", "checkpoint_number", "checkpoint_commit", "handoff_ref",
    "notes_source", "notes_reason", "tiers", "claims_count", "mismatches", "checks", "instruction_files_changed", "confirmations",
    "invisible_removed", "prompt_path",
  ]);
  expect(handoff.data.tiers).toEqual([0, 1]);
  expect(handoff.data.mismatches).toEqual([{ claim: "notes say `bun test` passes", found: "231 passed, 1 failed (exit code 1)" }]);
  expect(handoff.data.checks).toEqual([{ command: "bun test", outcome: "failed" }]);
  expect(JSON.stringify(handoff)).not.toContain("OUTPUT-MARKER");
  expect(Object.keys(handoffFailedEvent({ number: 3, toTarget: "codex:personal", step: "write", reason: "x", exitCode: 1, keptCheckpoint: 7 }).data))
    .toEqual(["number", "to_target", "step", "reason", "exit_code", "kept_checkpoint"]);
});
