// End to end on a scratch repository (task 9.8): a Claude worker that edits two files and stops at
// a limit, then a Codex run that the project's allow list refuses. The person's branch, index,
// stash and uncommitted files stay as they were.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readAvailability } from "../../src/accounts/availability";
import { personState } from "../helpers/job";
import { jobEvents, relayRun, resetTime, runFixture, steps, workers } from "./helpers";

test("relay run claude:work hits a limit, and codex:personal is refused by the allow list", async () => {
  const fixture = await runFixture();
  try {
    const before = personState(fixture.scratch.repo);
    const resets = resetTime();
    const claude = await relayRun(fixture, ["claude:work", "--headless", "--prompt", "Add the parser."], steps(
      { say: "Adding the parser." },
      { write: "src/parser.ts", content: "export const parse = (text: string) => text.trim();\n" },
      { write: "src/parser.test.ts", content: "import { parse } from './parser';\n" },
      { limit: { window: "five_hour", resets_at: resets.toISOString() } },
    ));
    expect(claude.code).toBe(23);
    expect(claude.stdout).toContain("  changed src/parser.ts\n  changed src/parser.test.ts\n");

    const codex = await relayRun(fixture, ["codex:personal", "--headless", "--prompt", "Continue."], steps({ say: "Continuing." }));
    expect(codex).toMatchObject({
      code: 25,
      stderr: "This project allows only claude:work. To hand the job to codex:personal, use relay switch, which asks before your code goes to another company.\n",
    });

    const [record] = workers(fixture);
    expect(workers(fixture)).toHaveLength(1);
    expect(record).toMatchObject({ account: "claude:work", transport: "claude-print", end_reason: "exited", exit_code: 1 });
    const listed = jobEvents(fixture);
    const types = listed.slice(listed.findIndex((event) => event.type === "worker_started")).map((event) => event.type);
    expect(types).toEqual(["worker_started", "worker_session_identified", "file_changed", "file_changed", "turn_failed", "availability", "worker_ended"]);
    expect(listed.filter((event) => event.type === "file_changed").map((event) => event.data.paths)).toEqual([["src/parser.ts"], ["src/parser.test.ts"]]);
    const availability = readAvailability(fixture.relayHome, { id: "claude:work", provider: "claude", name: "work" });
    expect(availability).toMatchObject({ state: "quota_exhausted", retryAt: resets, source: "stream_event" });
    expect(JSON.parse(readFileSync(join(fixture.relayHome, "accounts", "claude-work", "availability.json"), "utf8")).state).toBe("quota_exhausted");

    // The agent's two new files are the only change: branch, index, stash, refs and the person's
    // uncommitted files are as they were.
    const { files: filesBefore, status: statusBefore, ...gitBefore } = before;
    const { files: filesAfter, status: statusAfter, ...gitAfter } = personState(fixture.scratch.repo);
    expect(gitAfter).toEqual(gitBefore);
    const { "src/parser.ts": parser, "src/parser.test.ts": parserTest, ...otherFiles } = filesAfter;
    expect(otherFiles).toEqual(filesBefore);
    expect(parser && parserTest).toBeTruthy();
    expect(statusAfter.filter((entry) => !statusBefore.includes(entry)).join(" ")).toContain("src/parser");
    expect(statusBefore.every((entry) => statusAfter.includes(entry))).toBe(true);
  } finally {
    fixture.cleanup();
  }
});
