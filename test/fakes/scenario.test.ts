import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_STEPS, loadScenario, parseScenario, ScenarioError, turnSteps, unixSeconds, windowName, writeStepFile } from "./scenario";
import { readRecord, startRecord } from "./record";
import type { Step } from "./scenario";

const reset = "2026-10-07T15:45:00Z";
function folder(): string { return mkdtempSync(join(process.env.HOME!, "fake-scenario-")); }

test("every step kind parses and absent turns use the default steps", () => {
  const first: Step[] = [
    { say: "Working." }, { run: "true", exit_code: 0, delay_ms: 1 }, { write: "src/a.ts", content: "a" },
    { limit: { window: "primary", resets_at: reset } }, { error: "overloaded" },
    { crash: { signal: "SIGKILL" } }, { exit: 1 }, { hang: true },
  ];
  const second: Step[] = [
    { finish: true }, { stderr: "Warning." }, { raw: "{not json" }, { approval: { command: "true" } },
    { ignore_sigterm: true }, { status_line: { five_hour: 62, seven_day: 10, resets_at: reset } }, { notification: "Waiting." },
  ];
  const scenario = parseScenario({ version: 1, turns: [{ steps: first }, { steps: second }] });
  expect(turnSteps(scenario, 0)).toEqual(first);
  expect(turnSteps(scenario, 1)).toEqual(second);
  expect(turnSteps(scenario, 2)).toBe(DEFAULT_STEPS);
});

function refused(value: unknown, problem: string): void {
  let error: unknown;
  try { parseScenario(value); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(ScenarioError);
  expect((error as Error).message).toContain(problem);
}

test("invalid steps name their turn, step and problem", () => {
  refused({ version: 1, turns: [{ steps: [] }, { steps: [{ say: "A" }, { say: "B" }, { run: "" }] }] }, "Turn 2, step 3");
  const badSteps: [unknown, string][] = [
    [{ say: "A", finish: true }, "exactly one"], [{ say: "A", unknown: true }, 'unknown field "unknown"'],
    [{ unknown: true }, "exactly one"], [{ limit: { window: "primary", resets_at: "soon" } }, "limit.resets_at"],
    [{ approval: {} }, "approval"], [{ crash: { signal: "SIGTERM" } }, "crash.signal"],
    [{ raw: "first\nsecond" }, "raw"], [{ write: "/etc/x", content: "x" }, "write"],
  ];
  for (const [step, problem] of badSteps) refused({ version: 1, turns: [{ steps: [step] }] }, problem);
  refused({ version: 1, turns: [], unknown: true }, 'unknown field "unknown"');
  refused({ version: 2, turns: [] }, "version");
  refused({ version: 1, turns: [], tool_version: "2.1" }, "tool_version");
  refused({ version: 1, turns: [], hooks_trusted: "yes" }, "hooks_trusted");
  expect(parseScenario({ version: 1, turns: [], tool_version: "2.1.100", hooks_trusted: "modified" }))
    .toEqual({ version: 1, turns: [], tool_version: "2.1.100", hooks_trusted: "modified" });
});

test("loadScenario defaults, reads files and names invalid JSON files", () => {
  const previous = process.env.RELAY_FAKE_SCENARIO;
  delete process.env.RELAY_FAKE_SCENARIO;
  try { expect(loadScenario(undefined)).toEqual({ version: 1, turns: [] }); }
  finally {
    if (previous === undefined) delete process.env.RELAY_FAKE_SCENARIO;
    else process.env.RELAY_FAKE_SCENARIO = previous;
  }
  const file = join(folder(), "scenario.json");
  const scenario = { version: 1 as const, turns: [{ steps: [{ say: "Hello." }] }] };
  writeFileSync(file, JSON.stringify(scenario));
  expect(loadScenario(file)).toEqual(scenario);
  writeFileSync(file, "{not json");
  let error: unknown;
  try { loadScenario(file); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(ScenarioError);
  expect((error as Error).message).toContain(file);
});

test("time and provider window names use the shared conversion", () => {
  expect(unixSeconds(reset)).toBe(1791387900);
  expect(windowName("primary")).toBe("five_hour");
  expect(windowName("five_hour")).toBe("five_hour");
  expect(windowName("secondary")).toBe("seven_day");
  expect(windowName("seven_day")).toBe("seven_day");
});

test("writeStepFile creates parents, reports replacement and refuses traversal", () => {
  const root = folder();
  const file = join(root, "src", "a.ts");
  expect(writeStepFile(root, "src/a.ts", "first")).toEqual({ absolute: file, created: true });
  expect(writeStepFile(root, "src/a.ts", "second")).toEqual({ absolute: file, created: false });
  expect(readFileSync(file, "utf8")).toBe("second");
  expect(() => writeStepFile(root, "../outside.txt", "outside")).toThrow(ScenarioError);
  const elsewhere = folder();
  symlinkSync(elsewhere, join(root, "linked"));
  expect(() => writeStepFile(root, "linked/a.ts", "outside")).toThrow(ScenarioError);
  symlinkSync(join(elsewhere, "b.ts"), join(root, "src", "b.ts"));
  expect(() => writeStepFile(root, "src/b.ts", "outside")).toThrow(ScenarioError);
  expect(readdirSync(elsewhere)).toEqual([]);
});

test("records keep environment names without credential values and append input", () => {
  const file = join(folder(), "record.json");
  const previous = process.env.SOME_TOKEN;
  const value = "fake-" + randomUUID();
  process.env.SOME_TOKEN = value;
  try {
    const recorder = startRecord(["-p", "Start."], file);
    expect(recorder).not.toBeNull();
    const record = readRecord(file);
    expect(record.argv).toEqual(["-p", "Start."]);
    expect(record.cwd).toBe(process.cwd());
    expect(record.env_names).toContain("SOME_TOKEN");
    expect(record.env).toEqual({ CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,
      CODEX_HOME: process.env.CODEX_HOME ?? null, RELAY_JOB: process.env.RELAY_JOB ?? null, RELAY_TARGET: process.env.RELAY_TARGET ?? null });
    expect(readFileSync(file, "utf8")).not.toContain(value);
    recorder!.input("line");
    expect(readRecord(file).input).toEqual(["line"]);
    expect(readFileSync(file, "utf8")).not.toContain(value);
    expect(startRecord([], "")).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.SOME_TOKEN;
    else process.env.SOME_TOKEN = previous;
  }
});

for (const stdin of ["ignore", "pipe"] as const) {
  test(`stdinKind identifies ${stdin === "ignore" ? "end of file" : "a pipe"} in a child`, async () => {
    const recordPath = join(import.meta.dir, "record.ts");
    const script = `import { stdinKind } from ${JSON.stringify(recordPath)}; console.log(stdinKind());`;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: folder(), env: { ...process.env }, stdin, stdout: "pipe", stderr: "pipe",
    });
    let inputClosed = false;
    try {
      const output = await new Response(child.stdout).text();
      if (typeof child.stdin !== "number") child.stdin?.end();
      inputClosed = true;
      expect(output.trim()).toBe(stdin === "ignore" ? "eof" : "pipe");
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stderr).text()).toBe("");
    } finally {
      if (!inputClosed && typeof child.stdin !== "number") child.stdin?.end();
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  }, 2000);
}
