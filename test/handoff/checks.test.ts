import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openRepository, type Repository } from "../../src/git/repo";
import { resultText, runChecks, type CheckResult } from "../../src/handoff/checks";
import { makeScratchRepo, type ScratchRepo } from "../helpers/scratch-repo";

const JOB = "3f9a2c1d";
let scratch: ScratchRepo;
let repo: Repository;
beforeEach(async () => {
  scratch = makeScratchRepo();
  repo = await openRepository(scratch.repo);
});
afterEach(() => scratch.cleanup());

const check = (command: string, timeout_seconds = 600) => ({ command, timeout_seconds, added_at: "2026-10-07T14:02:11.000Z" });
const run = (commands: ReturnType<typeof check>[], options: { env?: Record<string, string>; handoff?: number; credentialNames?: string[] } = {}) =>
  runChecks({
    repo, jobId: JOB, relayHome: scratch.relayHome, handoff: options.handoff ?? 3, checks: commands,
    env: { ...process.env, ...options.env }, credentialNames: options.credentialNames ?? [],
    maxFileBytes: 20 * 1024 * 1024, approvedPaths: [],
  });
const logs = () => readdirSync(join(scratch.relayHome, "logs", "checks")).sort();
// Built at run time, so the repository holds no secret-looking value.
const fakeValue = () => ["sk", "live", "q7".repeat(10)].join("_");

describe("relay runs the checks at every handoff", () => {
  test("a check runs in the worktree root without credential variables and with relay's variables", async () => {
    const [result] = await run([check("env > env.txt; pwd > pwd.txt; cat")], {
      env: { ANTHROPIC_API_KEY: "a-test-value", OPENAI_API_KEY: "o-test-value", CLAUDE_CODE_OAUTH_TOKEN: "x", MY_PROVIDER_KEY: "y" },
      credentialNames: ["MY_PROVIDER_KEY"],
    });
    expect(result!.outcome).toBe("passed");
    const env = readFileSync(join(scratch.repo, "env.txt"), "utf8");
    for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "MY_PROVIDER_KEY"]) expect(env).not.toContain(`${name}=`);
    for (const line of ["RELAY_CHECK=1", "CI=1", "NO_COLOR=1"]) expect(env.split("\n")).toContain(line);
    expect(env.split("\n").filter((line) => line.startsWith("RELAY_"))).toEqual(["RELAY_CHECK=1"]);
    expect(readFileSync(join(scratch.repo, "pwd.txt"), "utf8").trim()).toBe(scratch.repo);
  });

  test("checks run once each, in order", async () => {
    const results = await run([check("echo one >> order.txt"), check("echo two >> order.txt; exit 2")]);
    expect(readFileSync(join(scratch.repo, "order.txt"), "utf8")).toBe("one\ntwo\n");
    expect(results.map(resultText)).toEqual(["passed", "failed (exit code 2)"]);
  });

  test("a check that never ends is stopped with SIGTERM, then SIGKILL 5 seconds later", async () => {
    const started = performance.now();
    const [result] = await run([check("trap '' TERM; while :; do sleep 0.1; done", 1)]);
    const seconds = (performance.now() - started) / 1000;
    expect(result!.outcome).toBe("timed_out");
    expect(result!.signal).toBe("SIGKILL");
    expect(resultText(result!)).toBe("did not finish in 1 second");
    expect(seconds).toBeGreaterThan(5.5);
    expect(seconds).toBeLessThan(10);
  }, 20_000);

  test("a check that ends on SIGTERM ends at the time limit", async () => {
    const [result] = await run([check("sleep 1000", 1)]);
    expect(result!.outcome).toBe("timed_out");
    expect(result!.seconds).toBeLessThan(3);
  }, 10_000);

  test("a missing program is a failed check with exit code 127, and the next check still runs", async () => {
    const results = await run([check("bunx-missing test"), check("true")]);
    expect(results.map(resultText)).toEqual(["failed (exit code 127)", "passed"]);
  });

  test("a check that starts a background program: the whole group is stopped", async () => {
    const pidFile = join(scratch.root, "background.pid");
    const [result] = await run([check(`sleep 1000 & echo $! > '${pidFile}'; echo started`)]);
    expect(result!.outcome).toBe("passed");
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("a job without checks runs nothing", async () => {
    expect(await run([])).toEqual([]);
  });
});

describe("Check output stays private and short", () => {
  test("the excerpt is cleaned and redacted, and the log has mode 0600", async () => {
    const secret = fakeValue();
    const command = `printf '\\033[31mred line\\033[0m\\n'; for i in $(seq 1 40); do echo "line $i"; done; echo "key is ${"$"}STRIPE_SECRET_KEY"; printf 'tab\\there\\a\\n'; echo ${"x".repeat(250)}; exit 1`;
    const [result] = await run([check(command)], { env: { STRIPE_SECRET_KEY: secret } });
    expect(result!.outcome).toBe("failed");
    expect(result!.excerpt).toHaveLength(30);
    expect(result!.excerpt.join("\n")).not.toContain("\x1b");
    expect(result!.excerpt.join("\n")).not.toContain(secret);
    expect(result!.excerpt).toContain("key is [redacted: STRIPE_SECRET_KEY]");
    expect(result!.excerpt).toContain("tab\there");
    expect(result!.excerpt.at(-1)).toBe("x".repeat(200));
    expect(result!.logPath).toBe(join(scratch.relayHome, "logs", "checks", `${JOB}-h3-1.log`));
    expect(statSync(result!.logPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(scratch.relayHome, "logs", "checks")).mode & 0o777).toBe(0o700);
    expect(readFileSync(result!.logPath, "utf8")).toContain("line 1\n");
  });

  test("a secret printed across two lines or broken by colour codes is still redacted", async () => {
    const secret = `${fakeValue()}\n${fakeValue().toUpperCase()}`;
    const [first, second] = secret.split("\n");
    const half = Math.floor(first!.length / 2);
    const command = `printf '%s\\n' "$PRIVATE_KEY"; printf '%s\\033[31m%s\\033[0m\\n' '${first!.slice(0, half)}' '${first!.slice(half)}'; exit 1`;
    const [result] = await run([check(command)], { env: { PRIVATE_KEY: secret } });
    const text = result!.excerpt.join("\n");
    for (const piece of [first!, second!]) expect(text).not.toContain(piece);
    // The whole two-line value is one replacement; the line broken by colour codes is the second.
    expect(result!.excerpt).toEqual(["[redacted: PRIVATE_KEY]", "[redacted: PRIVATE_KEY]"]);
  });

  test("colour codes are removed from the excerpt", async () => {
    const [result] = await run([check("printf '\\033[1;31mFAIL\\033[0m test\\n'; exit 1")]);
    expect(result!.excerpt).toEqual(["FAIL test"]);
  });

  test("a passing check has no excerpt", async () => {
    const [result] = await run([check("echo fine")]);
    expect(result!.excerpt).toEqual([]);
  });

  test("only the logs of the newest 20 handoffs remain", async () => {
    const folder = join(scratch.relayHome, "logs", "checks");
    mkdirSync(folder, { recursive: true });
    for (let handoff = 1; handoff <= 21; handoff++) writeFileSync(join(folder, `${JOB}-h${handoff}-1.log`), "old\n");
    writeFileSync(join(folder, "00000000-h1-1.log"), "another job\n");
    await run([check("true")], { handoff: 22 });
    const expected = [...Array.from({ length: 20 }, (_, i) => `${JOB}-h${i + 3}-1.log`), "00000000-h1-1.log"].sort();
    expect(logs()).toEqual(expected);
  });
});

describe("Files changed by the checks are reported, not reverted", () => {
  test("a rewritten snapshot is listed on the last check and keeps the content the check wrote", async () => {
    scratch.write("test/__snapshots__/a.snap", "old\n");
    const results = await run([check("echo new > test/__snapshots__/a.snap"), check("true")]);
    expect(results.map((result: CheckResult) => result.changedFiles)).toEqual([[], ["test/__snapshots__/a.snap"]]);
    expect(readFileSync(join(scratch.repo, "test/__snapshots__/a.snap"), "utf8")).toBe("new\n");
  });

  test("files in .relay/ are not listed", async () => {
    mkdirSync(join(scratch.repo, ".relay"), { recursive: true });
    const [result] = await run([check("echo x > .relay/task.md")]);
    expect(result!.changedFiles).toEqual([]);
    expect(existsSync(join(scratch.repo, ".relay/task.md"))).toBe(true);
  });
});
