import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandError } from "../../src/cli/errors";
import { readState, statePath, writeState, type JobState } from "../../src/job/state";

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(realpathSync(tmpdir()), "relay-test-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function sample(title = "main"): JobState {
  return {
    schema_version: 1,
    job_id: "3f9a2c1d",
    title,
    status: "active",
    created_at: "2026-10-07T20:31:05.123Z",
    updated_at: "2026-10-07T20:31:05.456Z",
    relay_version: "0.1.0",
    repository: { worktree_root: "/repo", common_git_dir: "/repo/.git", linked_worktree: false },
    start: { head: null, branch: "main", detached: false },
    latest_checkpoint: null,
    checkpoint_count: 0,
    approved_paths: [],
    last_rollback: null,
  };
}

test("a written state reads back the same", () => {
  writeState(dir, sample());
  expect(readState(dir)).toEqual(sample());
  expect(existsSync(`${statePath(dir)}.tmp`)).toBe(false);
});

test("a crash between writing and renaming leaves the old file", () => {
  writeState(dir, sample("old"));
  const before = readFileSync(statePath(dir));
  expect(() =>
    writeState(dir, sample("new"), () => {
      throw new Error("simulated crash");
    }),
  ).toThrow("simulated crash");
  expect(readFileSync(statePath(dir))).toEqual(before);
  expect(readState(dir).title).toBe("old");
});

test("a field relay does not know is read without error and kept", () => {
  writeFileSync(statePath(dir), JSON.stringify({ ...sample(), current_worker: { id: "5d2e8f01" } }));
  const state = readState(dir);
  expect(state.current_worker).toEqual({ id: "5d2e8f01" });
  writeState(dir, state);
  expect(JSON.parse(readFileSync(statePath(dir), "utf8")).current_worker).toEqual({ id: "5d2e8f01" });
});

test("a latest checkpoint with all its fields is valid", () => {
  const state = sample();
  state.latest_checkpoint = { number: 1, commit: "4be81c0", ref: "refs/relay/jobs/3f9a2c1d/checkpoints/1", kind: "baseline", created_at: "2026-10-07T20:31:05.400Z" };
  state.checkpoint_count = 1;
  writeState(dir, state);
  expect(readState(dir)).toEqual(state);
});

test.each([
  ["not JSON", "{", "it is not valid JSON"],
  ["a wrong job ID", JSON.stringify({ ...sample(), job_id: "../x" }), "job_id is missing or has the wrong type"],
  ["a missing field", JSON.stringify({ ...sample(), approved_paths: undefined }), "approved_paths is missing or has the wrong type"],
  ["a wrong nested field", JSON.stringify({ ...sample(), start: { head: 1, branch: null, detached: false } }), "start.head is missing or has the wrong type"],
])("a state.json with %s is damaged (exit code 3)", (_, text, problem) => {
  writeFileSync(statePath(dir), text);
  let error: unknown;
  try {
    readState(dir);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(CommandError);
  expect((error as CommandError).code).toBe(3);
  expect((error as CommandError).lines).toEqual([`The job file ${statePath(dir)} is damaged: ${problem}.`]);
});
