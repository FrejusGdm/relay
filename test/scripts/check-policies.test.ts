import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { setClock } from "../../src/platform/clock";
import { stalePolicyLines } from "../../scripts/check-policies";

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "check-policies.ts");
afterEach(() => setClock(null));

test("no policy is stale on 2026-10-08", () => {
  setClock(() => new Date("2026-10-08T12:00:00"));
  expect(stalePolicyLines()).toEqual([]);
});

test("both policies are stale on 2027-01-10", () => {
  setClock(() => new Date("2027-01-10T12:00:00"));
  expect(stalePolicyLines()).toEqual([
    "src/adapters/claude/policy.toml was last checked on 2026-10-07, 95 days ago (more than 90). Check the Claude Code terms again and update checked_on.",
    "src/adapters/codex/policy.toml was last checked on 2026-10-07, 95 days ago (more than 90). Check the Codex terms again and update checked_on.",
  ]);
});

test("the script exits 1 with a stale date and 0 otherwise", async () => {
  // The script reads the real clock; a fake clock cannot reach a child process, so the expected
  // code follows from today's date.
  const child = Bun.spawn([process.execPath, SCRIPT], { stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  setClock(null);
  const stale = stalePolicyLines();
  expect(code).toBe(stale.length > 0 ? 1 : 0);
  expect(stderr).toBe(stale.map((line) => `${line}\n`).join(""));
});
