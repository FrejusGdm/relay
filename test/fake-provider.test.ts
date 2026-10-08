import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FOLDER = join(import.meta.dir, "fixtures", "fake-provider");

function runScenario(name: string, env: Record<string, string | undefined> = process.env) {
  const file = name.endsWith(".json") ? name : join(FOLDER, "scenarios", `${name}.json`);
  const result = Bun.spawnSync([process.execPath, join(FOLDER, "fake-agent.ts"), file], { env });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

test("finish-ok prints its lines in order and exits 0", () => {
  const result = runScenario("finish-ok");
  expect(result.stdout).toBe("working\ndone\n");
  expect(result.code).toBe(0);
});

test("crash prints to standard error and exits 1", () => {
  const result = runScenario("crash");
  expect(result.stderr).toBe("fake agent crashed\n");
  expect(result.code).toBe(1);
});

test("slow takes at least 200 ms", () => {
  const started = performance.now();
  const result = runScenario("slow");
  expect(performance.now() - started).toBeGreaterThanOrEqual(200);
  expect(result.code).toBe(0);
});

test("the record lists variable names and never their values", () => {
  const recordFile = join(mkdtempSync(join(process.env.HOME!, "record-")), "record.json");
  const value = "fake-" + crypto.randomUUID();
  runScenario("finish-ok", { ...process.env, FAKE_AGENT_RECORD: recordFile, SOME_TOKEN: value });
  const text = readFileSync(recordFile, "utf8");
  expect(JSON.parse(text).env_names).toContain("SOME_TOKEN");
  expect(text).not.toContain(value);
});

test("an unknown step stops the fake agent with exit 2", () => {
  const file = join(mkdtempSync(join(process.env.HOME!, "scenario-")), "unknown.json");
  writeFileSync(file, JSON.stringify({ description: "An unknown step.", steps: [{ beep: 1 }, { stdout: "late" }] }));
  const result = runScenario(file);
  expect(result.stderr).toBe("fake agent: unknown step\n");
  expect(result.stdout).toBe("");
  expect(result.code).toBe(2);
});
