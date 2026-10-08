// These tests check runner fixtures and the summary formats each parser accepts.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCounts } from "../../src/handoff/check-parsers";
import { parseBun } from "../../src/handoff/check-parsers/bun";
import { parseVitest } from "../../src/handoff/check-parsers/vitest";
import { parseJest } from "../../src/handoff/check-parsers/jest";
import { parsePytest } from "../../src/handoff/check-parsers/pytest";
import { parseCargo } from "../../src/handoff/check-parsers/cargo";

function fixture(name: string): string {
  return readFileSync(join(import.meta.dir, "..", "fixtures", "checks", name), "utf8");
}

for (const runner of ["bun", "vitest", "jest", "pytest", "cargo"]) {
  test(`${runner} passing fixture`, () => {
    expect(parseCounts(fixture(`${runner}-pass.txt`))).toEqual({ passed: 12, failed: 0, skipped: 0 });
  });
  test(`${runner} failing fixture`, () => {
    expect(parseCounts(fixture(`${runner}-fail.txt`))).toEqual({ passed: 231, failed: 1, skipped: 3 });
  });
}

test("unrecognized and empty output return null", () => {
  expect(parseCounts(fixture("unrecognized.txt"))).toBeNull();
  expect(parseCounts("")).toBeNull();
});

test("each parser rejects another runner's output", () => {
  expect(parseBun(fixture("vitest-fail.txt"))).toBeNull();
  expect(parseVitest(fixture("jest-fail.txt"))).toBeNull();
  expect(parseJest(fixture("pytest-fail.txt"))).toBeNull();
  expect(parsePytest(fixture("bun-fail.txt"))).toBeNull();
  expect(parseCargo(fixture("jest-fail.txt"))).toBeNull();
});

test("Bun uses the last count of each kind and requires pass or fail", () => {
  expect(parseBun(" 9 pass\n 2 fail\n 7 skip\n 12 pass\n 0 fail\n 0 skip\n")).toEqual({ passed: 12, failed: 0, skipped: 0 });
  expect(parseBun(" 0 fail\n")).toEqual({ passed: 0, failed: 0, skipped: 0 });
  expect(parseBun(" 3 skip\n(pass) test\n(fail) test\n 500 expect() calls\n")).toBeNull();
});

test("Vitest and Jest use the last summary and count todo as skipped", () => {
  expect(parseVitest("      Tests  1 failed | 2 passed (3)\n      Tests  12 passed | 2 skipped | 1 todo (15)\n")).toEqual({ passed: 12, failed: 0, skipped: 3 });
  expect(parseJest("Tests: 1 failed, 2 passed, 3 total\nTests: 12 passed, 2 skipped, 1 todo, 15 total\n")).toEqual({ passed: 12, failed: 0, skipped: 3 });
  expect(parseVitest("Tests  12 passed")).toBeNull();
  expect(parseJest("Tests: 12 passed")).toBeNull();
});

test("pytest uses the last summary and maps additional outcomes", () => {
  expect(parsePytest("=== 1 failed in 0.01s ===\n10 passed, 2 xpassed, 1 skipped, 2 xfailed, 1 error, 2 errors, 4 warnings, 5 deselected in 62.00s (0:01:02)\n")).toEqual({ passed: 12, failed: 3, skipped: 3 });
  expect(parsePytest("1 warning in 0.01s")).toEqual({ passed: 0, failed: 0, skipped: 0 });
  expect(parsePytest("12 passed in 1.00s trailing text")).toBeNull();
});

test("terminal colours and carriage returns are removed before parsing", () => {
  expect(parseCounts("\x1b[32m 12 pass\x1b[0m\r\n 0 fail\r\n")).toEqual({ passed: 12, failed: 0, skipped: 0 });
});

test("the exit code alone decides whether a check passed", async () => {
  const { runChecks, resultText } = await import("../../src/handoff/checks");
  const { openRepository } = await import("../../src/git/repo");
  const { makeScratchRepo } = await import("../helpers/scratch-repo");
  const scratch = makeScratchRepo();
  try {
    const check = (command: string) => ({ command, timeout_seconds: 60, added_at: "2026-10-07T14:02:11.000Z" });
    const results = await runChecks({
      repo: await openRepository(scratch.repo), jobId: "3f9a2c1d", relayHome: scratch.relayHome, handoff: 1,
      checks: [check("printf ' 5 pass\\n 0 fail\\n'; exit 1"), check("printf ' 4 pass\\n 2 fail\\n'"), check("echo nothing known")],
      env: process.env, credentialNames: [], maxFileBytes: 1024 * 1024, approvedPaths: [],
    });
    expect(results.map((result) => [result.outcome, resultText(result)])).toEqual([
      ["failed", "5 passed, 0 failed (exit code 1)"],
      ["passed", "4 passed, 2 failed"],
      ["passed", "passed"],
    ]);
    expect(results[2]!.counts).toBeNull();
  } finally {
    scratch.cleanup();
  }
});
