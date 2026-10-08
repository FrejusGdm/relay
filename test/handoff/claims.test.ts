import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { CheckResult } from "../../src/handoff/checks";
import { compareClaims } from "../../src/handoff/claims";
import { parseNotes } from "../../src/handoff/notes-parse";
import { makeJob, type Job } from "./job";

setDefaultTimeout(30_000);

let job: Job;
let work: string;
beforeAll(async () => {
  job = await makeJob();
  job.scratch.write("src/auth/callback.ts", "export function handleCallback() {}\n");
  job.scratch.write("src/auth/session.ts", "export const session = 1;\n");
  work = await job.save();
});
afterAll(() => job.scratch.cleanup());

const check = (command: string, outcome: CheckResult["outcome"], counts: CheckResult["counts"] = null, exitCode: number | null = outcome === "passed" ? 0 : 1): CheckResult => ({
  command, outcome, exitCode, signal: null, seconds: 1, counts, logPath: "", excerpt: [], changedFiles: [], timeoutSeconds: 600,
});
const BUN_FAILS = check("bun test", "failed", { passed: 231, failed: 1, skipped: 0 });
const compare = async (notes: string, checks: CheckResult[] = [BUN_FAILS], changed = ["src/auth/callback.ts"]) =>
  compareClaims(await job.repo(), { notes: parseNotes(notes), checks, changedWhileWorking: changed, workCheckpoint: work, from: "claude" });

describe("Claims are compared with facts", () => {
  test("a false claim that a check passes", async () => {
    const mismatches = await compare("## Claims to verify\n- `bun test` passes. Check: run `bun test`.\n");
    expect(mismatches).toEqual([{
      kind: "check", claim: "notes say `bun test` passes", found: "231 passed, 1 failed (exit code 1)",
      sentence: "The notes say `bun test` passes. relay ran it: 231 passed, 1 failed (exit code 1).",
    }]);
    expect(mismatches.map(({ claim, found }) => ({ claim, found }))).toEqual([{ claim: "notes say `bun test` passes", found: "231 passed, 1 failed (exit code 1)" }]);
  });

  test.each(["passes", "passed", "passing", "is green", "succeeds", "succeeded", "PASS"])("the pass word %p", async (word) => {
    expect(await compare(`## Claims to verify\n- \`bun test\` ${word}.\n`)).toHaveLength(1);
  });

  test.each(["fails", "failed", "failing", "is red", "is broken", "fail"])("the fail word %p against a passing check", async (word) => {
    const mismatches = await compare(`## Claims to verify\n- \`bun run lint\` ${word}. Check: run it.\n`, [check("bun run lint", "passed")]);
    expect(mismatches.map((mismatch) => mismatch.sentence)).toEqual(["The notes say `bun run lint` fails. relay ran it: passed."]);
  });

  test("a claim with both a pass word and a fail word gives no comparison", async () => {
    expect(await compare("## Claims to verify\n- `bun test` passes except one test that fails.\n")).toEqual([]);
  });

  test("a claim that matches relay's result, or names no recorded check, gives no difference", async () => {
    expect(await compare("## Claims to verify\n- `bun test` fails on one test.\n")).toEqual([]);
    expect(await compare("## Claims to verify\n- bun test passes.\n- `npm test` passes.\n")).toEqual([]);
    expect(await compare("## Claims to verify\n- the callback handles state mismatches.\n")).toEqual([]);
  });

  test("a word inside the command does not count", async () => {
    expect(await compare("## Claims to verify\n- `bun test --fail-fast` was run.\n", [check("bun test --fail-fast", "passed")])).toEqual([]);
  });

  test("a file listed under Files touched that did not change", async () => {
    const mismatches = await compare("## Files touched\n- src/auth/callback.ts\n- `src/auth/session.ts`\n");
    expect(mismatches).toEqual([{
      kind: "file_not_changed", claim: "notes list `src/auth/session.ts` as changed", found: "it did not change while Claude Code worked",
      sentence: "The notes list `src/auth/session.ts` as changed, but it did not change while Claude Code worked.",
    }]);
  });

  test("a path in Done or Claims that does not exist in the work checkpoint", async () => {
    const mismatches = await compare("## Done\n- Added `src/auth/oauth.ts` and `src/auth/callback.ts`.\n## Claims to verify\n- `docs/auth.md` explains it.\n## Next steps\n- Write `src/later.ts`.\n");
    const short = work.slice(0, 6);
    expect(mismatches.map((mismatch) => mismatch.sentence)).toEqual([
      `The notes mention \`src/auth/oauth.ts\`, which does not exist in checkpoint ${short}.`,
      `The notes mention \`docs/auth.md\`, which does not exist in checkpoint ${short}.`,
    ]);
    expect(mismatches[0]).toMatchObject({ kind: "path_missing", claim: "notes mention `src/auth/oauth.ts`", found: `it does not exist in checkpoint ${short}` });
  });

  test.each([
    ["a token with a space", "`src/a file.ts`"],
    ["a token with ..", "`../secret.ts`"],
    ["a URL", "`https://example.com/a.ts`"],
    ["an option", "`--config/x.ts`"],
    ["an absolute path", "`/etc/passwd.d`"],
    ["a word without a slash or an ending", "`handleCallback`"],
    ["a token of 121 characters", `\`src/${"a".repeat(117)}\``],
    ["a token with other characters", "`src/a$(rm).ts`"],
    ["a token with a non-ASCII letter", "`src/café.ts`"],
  ])("%s is not a path", async (_name, token) => {
    expect(await compare(`## Done\n- Added ${token}.\n## Files touched\n- ${token.slice(1, -1)}\n`)).toEqual([]);
  });

  test("the same difference is reported once", async () => {
    expect(await compare("## Done\n- `src/x.ts`\n## Claims to verify\n- `src/x.ts` exists.\n- `bun test` passes.\n- `bun test` passed.\n")).toHaveLength(2);
  });
});
