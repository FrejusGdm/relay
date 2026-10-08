import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseScenario, parseStep } from "../fakes/scenario";

const DOC = readFileSync(join(import.meta.dir, "..", "..", "docs", "testing-adapters.md"), "utf8");
const examples = [...DOC.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => JSON.parse(match[1]!) as Record<string, unknown>);
const STEP_KINDS = [
  "say", "run", "write", "limit", "error", "crash", "exit", "hang", "finish",
  "stderr", "raw", "approval", "ignore_sigterm", "status_line", "notification",
];

test("every scenario example in docs/testing-adapters.md passes the scenario check", () => {
  const scenarios = examples.filter((example) => "version" in example);
  expect(scenarios.length).toBeGreaterThan(0);
  for (const scenario of scenarios) expect(() => parseScenario(scenario)).not.toThrow();
});

test("the document has one valid example for each step", () => {
  const steps = examples.filter((example) => !("version" in example));
  for (const step of steps) expect(() => parseStep(step)).not.toThrow();
  expect(steps.map((step) => Object.keys(step)[0]).sort()).toEqual([...STEP_KINDS].sort());
});

test("the document names the variables and the guard programs", () => {
  for (const text of ["RELAY_CLAUDE_BIN", "RELAY_CODEX_BIN", "RELAY_FAKE_SCENARIO", "RELAY_FAKE_RECORD", "guard-bin"]) {
    expect(DOC).toContain(text);
  }
});
