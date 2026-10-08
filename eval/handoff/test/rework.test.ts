import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { measureRework } from "../src/rework.ts";
import { cleanup, commitAll, gitRepo } from "./helpers.ts";

afterEach(cleanup);

const lines = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}\n`).join("");

// Commits the base, the first agent's work and the next agent's work, and measures the rework.
async function rework(first: (repo: string) => void, next: (repo: string) => void) {
  const repo = await gitRepo({ "src/keep.ts": lines("kept", 5) });
  const base = await commitAll(repo, "base");
  first(repo);
  const handoff = await commitAll(repo, "handoff");
  next(repo);
  const final = await commitAll(repo, "final");
  return await measureRework(repo, base, handoff, final);
}

test("The next agent only adds lines", async () => {
  expect(await rework(
    (repo) => writeFileSync(join(repo, "src/new.ts"), lines("first", 10)),
    (repo) => writeFileSync(join(repo, "src/new.ts"), lines("first", 10) + lines("next", 4)),
  )).toEqual({ lines_added_before: 10, lines_reverted: 0, rework_ratio: 0, files_reworked: [] });
});

test("The next agent rewrites 3 of 10 added lines", async () => {
  expect(await rework(
    (repo) => writeFileSync(join(repo, "src/new.ts"), lines("first", 10)),
    (repo) => writeFileSync(join(repo, "src/new.ts"), lines("first", 10).replace("first 4\nfirst 5\nfirst 6\n", "next 4\nnext 5\nnext 6\nnext 7\n")),
  )).toEqual({ lines_added_before: 10, lines_reverted: 3, rework_ratio: 0.3, files_reworked: ["src/new.ts"] });
});

test("The next agent deletes a file the first agent created", async () => {
  expect(await rework(
    (repo) => {
      writeFileSync(join(repo, "src/new.ts"), lines("first", 6));
      writeFileSync(join(repo, "src/keep.ts"), lines("kept", 5) + lines("also", 2));
    },
    (repo) => rmSync(join(repo, "src/new.ts")),
  )).toEqual({ lines_added_before: 8, lines_reverted: 6, rework_ratio: 0.75, files_reworked: ["src/new.ts"] });
});

test("Nothing added gives a null ratio, and job files are left out", async () => {
  expect(await rework(
    (repo) => {
      mkdirSync(join(repo, ".relay"));
      writeFileSync(join(repo, ".relay", "events.jsonl"), lines("event", 3));
    },
    (repo) => writeFileSync(join(repo, ".relay", "events.jsonl"), lines("other", 3)),
  )).toEqual({ lines_added_before: 0, lines_reverted: 0, rework_ratio: null, files_reworked: [] });
});

test("Lines that start with -- or ++ inside a hunk are not taken for file headers", async () => {
  const sql = (lines: string[]) => `${lines.join("\n")}\n`;
  const first = ["select 1;", "-- first note", "select 2;", "select 3;", "select 4;", "select 5;", "select 6;"];
  expect(await rework(
    (repo) => {
      writeFileSync(join(repo, "a.sql"), sql(first));
      writeFileSync(join(repo, "b.sql"), sql(["select 7;", "select 8;"]));
    },
    (repo) => {
      // Two hunks in a.sql: the first removes "-- first note" (shown as "--- first note") and adds
      // "++ added" (shown as "+++ added"); the second must still count for a.sql.
      writeFileSync(join(repo, "a.sql"), sql(first.map((line) => (line === "-- first note" ? "++ added" : line === "select 6;" ? "select 9;" : line))));
      writeFileSync(join(repo, "b.sql"), sql(["select 7;"]));
    },
  )).toEqual({ lines_added_before: 9, lines_reverted: 3, rework_ratio: 0.333, files_reworked: ["a.sql", "b.sql"] });
});
