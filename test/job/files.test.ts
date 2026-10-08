import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointTemplate, decisionsTemplate, taskTemplate, writeTemplates } from "../../src/job/files";

let root: string;
beforeEach(() => (root = mkdtempSync(join(realpathSync(tmpdir()), "relay-test-"))));
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("task.md has the exact template", () => {
  expect(taskTemplate("auth-refactor", "3f9a2c1d")).toBe(
    [
      "# auth-refactor",
      "",
      "<!-- relay job 3f9a2c1d. Agents read this file first. Keep it current. -->",
      "",
      "## Goal",
      "",
      "Describe what this job should achieve.",
      "",
      "## Acceptance criteria",
      "",
      "- [ ] Describe how to tell the job is done.",
      "",
      "## Plan",
      "",
      "## Done",
      "",
      "## In progress",
      "",
      "## Left to do",
      "",
    ].join("\n"),
  );
});

test("checkpoint.md has the exact template", () => {
  expect(checkpointTemplate("3f9a2c1d")).toBe(
    "# Checkpoint\n\n<!-- relay job 3f9a2c1d. The latest handoff, written for the next agent. -->\n\nNo handoff yet. relay writes this file when work moves to another agent.\n",
  );
});

test("decisions.md has the exact template", () => {
  expect(decisionsTemplate("3f9a2c1d")).toBe(
    "# Decisions\n\n<!-- relay job 3f9a2c1d. One entry per decision, newest last: the date, the decision, and why. -->\n",
  );
});

test("writeTemplates writes the three files", () => {
  writeTemplates(root, "3f9a2c1d", "Demo");
  expect(readFileSync(join(root, "task.md"), "utf8")).toBe(taskTemplate("Demo", "3f9a2c1d"));
  expect(readFileSync(join(root, "checkpoint.md"), "utf8")).toBe(checkpointTemplate("3f9a2c1d"));
  expect(readFileSync(join(root, "decisions.md"), "utf8")).toBe(decisionsTemplate("3f9a2c1d"));
});

test("writeTemplates never writes through a symbolic link or over a file", () => {
  const outside = join(root, "outside.txt");
  writeFileSync(outside, "keep\n");
  const dir = join(root, "relay");
  mkdirSync(dir);
  symlinkSync(outside, join(dir, "task.md"));
  expect(() => writeTemplates(dir, "3f9a2c1d", "Demo")).toThrow();
  expect(readFileSync(outside, "utf8")).toBe("keep\n");
});
