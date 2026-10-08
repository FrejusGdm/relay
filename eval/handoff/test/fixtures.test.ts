import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFixtures } from "../src/fixtures.ts";

const data = join(import.meta.dir, "data", "fixtures");
const folders: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-eval-fixtures-test-"));
  folders.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function check(taskIds: string[], tasksDir = data) {
  let out = "";
  let err = "";
  const code = await checkFixtures({
    tasksDir, taskIds,
    out: (text) => { out += text; },
    err: (text) => { err += text; },
  });
  return { code, out, err };
}

function copyReady(tasksDir: string, id: string): string {
  const dir = join(tasksDir, id);
  cpSync(join(data, "tiny-ready"), dir, { recursive: true });
  const path = join(dir, "task.toml");
  writeFileSync(path, readFileSync(path, "utf8").replace('id = "tiny-ready"', `id = "${id}"`));
  return dir;
}

test("A correct reference solution makes a fixture ready", async () => {
  expect(await check(["tiny-ready"])).toEqual({ code: 0, out: "tiny-ready is ready.\n", err: "" });
}, 30000);

test("A broken reference solution reports its failing test names", async () => {
  const result = await check(["tiny-broken-solution"]);
  expect(result.code).toBe(1);
  expect(result.err.startsWith("Fixture tiny-broken-solution: the reference solution fails 2 acceptance tests.\n")).toBe(true);
  expect(result.err).toContain("  Subtraction returns a positive difference\n");
  expect(result.err).toContain("  Subtraction returns a negative difference\n");
}, 30000);

test("Checking every fixture fails if any solution is broken", async () => {
  const result = await check([]);
  expect(result.code).toBe(1);
  expect(result.out).toBe("tiny-ready is ready.\n");
  expect(result.out).not.toContain("All 2 fixtures are ready.");
}, 30000);

test("A named fixture must exist before checking starts", async () => {
  expect(await check(["nope"])).toEqual({ code: 2, out: "", err: `No fixture nope in ${data}.\n` });
}, 30000);

test("Missing metadata is reported before running a fixture", async () => {
  const tasksDir = temp();
  const dir = copyReady(tasksDir, "tiny-ready");
  const path = join(dir, "task.toml");
  writeFileSync(path, readFileSync(path, "utf8").replace(/^acceptance_total = .*\n/m, ""));
  expect(await check(["tiny-ready"], tasksDir)).toEqual({
    code: 1, out: "", err: "Fixture tiny-ready: task.toml has no acceptance_total.\n",
  });
}, 30000);

test("Two ready fixtures produce the final success message", async () => {
  const tasksDir = temp();
  copyReady(tasksDir, "one");
  copyReady(tasksDir, "two");
  const result = await check([], tasksDir);
  expect(result.code).toBe(0);
  expect(result.err).toBe("");
  expect(result.out).toBe("one is ready.\ntwo is ready.\nAll 2 fixtures are ready.\n");
}, 30000);

test("An acceptance file that fails to load fails the check even when the counts match", async () => {
  const tasksDir = temp();
  const dir = copyReady(tasksDir, "tiny-ready");
  writeFileSync(join(dir, ".acceptance", "broken.test.ts"), 'import "./missing.ts";\n');
  const result = await check(["tiny-ready"], tasksDir);
  expect(result.code).toBe(1);
  expect(result.err).toBe("Fixture tiny-ready: the acceptance tests exit with code 1 with the reference solution.\n");
}, 30000);

test("More acceptance tests than task.toml declares fail the check", async () => {
  const tasksDir = temp();
  const dir = copyReady(tasksDir, "tiny-ready");
  const path = join(dir, "task.toml");
  writeFileSync(path, readFileSync(path, "utf8").replace("acceptance_total = 3", "acceptance_total = 2"));
  const result = await check(["tiny-ready"], tasksDir);
  expect(result.code).toBe(1);
  expect(result.err).toBe("Fixture tiny-ready: the acceptance tests report 3 tests, but task.toml says 2.\n");
}, 30000);

test("The rate-limiter tests accept a check result with an extra field", async () => {
  const tasksDir = temp();
  const dir = join(tasksDir, "rate-limiter");
  cpSync(join(import.meta.dir, "..", "tasks", "rate-limiter"), dir, { recursive: true });
  const limiter = join(dir, "solution", "src", "limiter.ts");
  const source = readFileSync(limiter, "utf8");
  const changed = source
    .replace("{ allowed: true, retryAfterMs: 0 }", "{ allowed: true, retryAfterMs: 0, remaining: 0 }")
    .replace("{ allowed: false, retryAfterMs: entry.bucket.msUntil() }", "{ allowed: false, retryAfterMs: entry.bucket.msUntil(), remaining: 0 }");
  expect(changed).not.toBe(source);
  writeFileSync(limiter, changed);
  expect(await check(["rate-limiter"], tasksDir)).toEqual({ code: 0, out: "rate-limiter is ready.\n", err: "" });
}, 30000);
