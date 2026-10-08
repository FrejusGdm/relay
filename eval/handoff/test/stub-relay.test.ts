import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../src/git.ts";
import { cleanup, gitRepo, readEvents, STUB_RELAY, stub, writeScenario } from "./helpers.ts";

afterEach(cleanup);

const verifyTable = "| Claim | Holds | Evidence |\n|---|---|---|\n| Tests pass | yes | bun test |\n";

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await Bun.sleep(20);
  }
}

test("The stub plays a scenario with a switch and records events and checkpoint refs", async () => {
  const repo = await gitRepo({ "a.txt": "one\n", "NOTES.md": "# Notes\n" });
  const indexBefore = readFileSync(join(repo, ".git", "index"));
  const scenario = writeScenario({
    workers: {
      "claude:eval-test": {
        step_delay_ms: 300,
        steps: [{ write: "a.txt", content: "two\n" }, { run: ["true"] }, { run: ["false"] }, { run: ["false"] }],
        end: "exited",
      },
      "codex:eval-test": {
        step_delay_ms: 50,
        steps: [{ append: "a.txt", content: "three\n" }, { verify: verifyTable }],
        usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5, reasoning_output_tokens: 1 },
        end: "exited",
      },
    },
    switch: { claims_count: 2, mismatches: [{ claim: "All tests pass", found: "one test fails" }] },
    status: { "codex:eval-test": { status: "rate_limited", retry_at: "2026-10-08T15:00:00Z", used_percent: 97 } },
  });

  expect(await stub(repo, ["--version"])).toEqual({ exitCode: 0, stdout: "relay 0.0.0-stub\n", stderr: "" });
  expect((await stub(repo, ["init", "--title", "eval test"])).exitCode).toBe(0);
  const job = (JSON.parse(readFileSync(join(repo, ".relay", "state.json"), "utf8")) as { job_id: string }).job_id;
  expect(job).toMatch(/^[0-9a-f]{8}$/);

  const run = Bun.spawn([STUB_RELAY, "run", "claude:eval-test", "--headless", "--prompt", "Do it.", "--json"], {
    cwd: repo, env: { ...process.env, RELAY_STUB_SCENARIO: scenario }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const printed = new Response(run.stdout).text();
  await waitFor(() => readEvents(repo).filter((event) => event.type === "command_ran").length >= 1, "the first command");
  const switched = await stub(repo, ["switch", "codex:eval-test", "--yes", "--json"], scenario);
  expect(switched.exitCode).toBe(0);
  const answer = JSON.parse(switched.stdout) as Record<string, unknown>;
  expect(answer).toMatchObject({ handoff_id: 1, outcome: "started", notes_source: "agent", mismatches: 1 });
  expect(existsSync(answer.prompt_path as string)).toBe(true);
  expect(await run.exited).toBe(0);

  const events = readEvents(repo);
  const types = events.map((event) => event.type);
  expect(types.slice(0, 4)).toEqual(["job_started", "checkpoint_saved", "worker_started", "worker_session_identified"]);
  expect(types.filter((type) => type === "worker_started")).toHaveLength(2);
  const ended = events.filter((event) => event.type === "worker_ended").map((event) => event.data.end_reason);
  expect(ended).toEqual(["stopped_by_switch", "exited"]);
  const handoff = events.find((event) => event.type === "handoff")!;
  expect(handoff.data).toMatchObject({ number: 1, from_target: "claude:eval-test", to_target: "codex:eval-test", claims_count: 2 });
  expect(handoff.data.checkpoint_commit).toBe(answer.checkpoint_sha);
  expect(events.find((event) => event.type === "turn_completed")!.data.usage).toEqual({ input_tokens: 10, cached_input_tokens: 2, output_tokens: 5, reasoning_output_tokens: 1 });
  expect(events.filter((event) => event.type === "command_ran").map((event) => event.data.exit_code)[0]).toBe(0);
  expect((await printed).trim().split("\n").map((line) => (JSON.parse(line) as { type: string }).type))
    .toEqual(types.slice(2));
  expect(readFileSync(join(repo, ".relay", "verify.md"), "utf8")).toBe(verifyTable);

  const saved = await stub(repo, ["checkpoint", "-m", "final", "--json"]);
  expect(JSON.parse(saved.stdout)).toMatchObject({ saved: true, number: 3 });
  expect(JSON.parse((await stub(repo, ["checkpoint", "--message", "again", "--json"])).stdout)).toEqual({ saved: false, latest: 3 });
  const list = JSON.parse((await stub(repo, ["checkpoints", "--json"])).stdout) as { number: number; kind: string; commit: string }[];
  expect(list.map((item) => [item.number, item.kind])).toEqual([[3, "manual"], [2, "handoff"], [1, "baseline"]]);
  const refs = (await git(repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/relay/"])).stdout.trim().split("\n");
  expect(refs).toEqual([
    `refs/relay/jobs/${job}/checkpoints/1 ${list[2]!.commit}`,
    `refs/relay/jobs/${job}/checkpoints/2 ${list[1]!.commit}`,
    `refs/relay/jobs/${job}/checkpoints/3 ${list[0]!.commit}`,
    `refs/relay/jobs/${job}/latest ${list[0]!.commit}`,
  ]);
  const files = (await git(repo, ["ls-tree", "-r", "--name-only", list[0]!.commit])).stdout.trim().split("\n");
  expect(files).toContain(".relay/verify.md");
  expect((await git(repo, ["show", `${list[1]!.commit}:a.txt`])).stdout).toBe("two\n");
  expect(readFileSync(join(repo, ".git", "index"))).toEqual(indexBefore);
  expect((await git(repo, ["status", "--porcelain"])).stdout).toBe(" M a.txt\n");

  const status = JSON.parse((await stub(repo, ["status", "--json"], scenario)).stdout) as { accounts: unknown[] };
  expect(status.accounts).toEqual([
    { target: "claude:eval-test", availability: { status: "available", retry_at: null }, usage: [] },
    { target: "codex:eval-test", availability: { status: "rate_limited", retry_at: "2026-10-08T15:00:00Z" }, usage: [{ window: "five_hour", used_percent: 97 }] },
  ]);
}, 60000);

test("The stub ends a run with 130 on SIGINT and with 23 or 24 at a limit or failure", async () => {
  const repo = await gitRepo({ "a.txt": "one\n" });
  expect((await stub(repo, ["init", "--title", "eval test"])).exitCode).toBe(0);
  const scenario = writeScenario({
    workers: {
      "claude:eval-test": { steps: [{ write: "a.txt", content: "two\n" }], end: "hang" },
      "codex:eval-test": { steps: [], end: "usage_limit", retry_at: "2026-10-08T16:00:00Z" },
      "claude:failing": { steps: [], end: "failed" },
    },
  });
  const run = Bun.spawn([STUB_RELAY, "run", "claude:eval-test", "--headless", "--prompt", "Do it.", "--json"], {
    cwd: repo, env: { ...process.env, RELAY_STUB_SCENARIO: scenario }, stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  await waitFor(() => readEvents(repo).some((event) => event.type === "file_changed"), "the edit");
  run.kill("SIGINT");
  expect(await run.exited).toBe(130);
  expect(readEvents(repo).at(-1)).toMatchObject({ type: "worker_ended", data: { end_reason: "interrupted", signal: "SIGINT" } });

  expect((await stub(repo, ["run", "codex:eval-test", "--headless", "--prompt", "Do it."], scenario)).exitCode).toBe(23);
  expect(readEvents(repo).find((event) => event.type === "turn_failed")!.data).toMatchObject({ reason: "usage_limit", retry_at: "2026-10-08T16:00:00Z" });
  expect((await stub(repo, ["run", "claude:failing", "--headless", "--prompt", "Do it."], scenario)).exitCode).toBe(24);
  expect(readEvents(repo).filter((event) => event.type === "turn_failed").at(-1)!.data.reason).toBe("crashed");
}, 60000);
