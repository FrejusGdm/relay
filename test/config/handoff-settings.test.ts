import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { validateConfig } from "../../src/core/config/validate";
import { parseToml } from "../../src/platform/toml";
import { runRelayInProcess } from "../helpers/cli";
import { makeRelayHome } from "../helpers/home";

const ctx = { relayHome: "/r", homedir: "/Users/josue" };
const validate = (text: string) => {
  const { config, problems } = validateConfig(parseToml(text), ctx);
  return { handoff: config.handoff, problems: problems.map(({ key, message }) => `${key}: ${message}`) };
};

const SETTINGS = [
  ["summary_timeout_seconds", "summaryTimeoutSeconds", 10, 900, 120],
  ["stop_timeout_seconds", "stopTimeoutSeconds", 5, 300, 30],
  ["check_timeout_seconds", "checkTimeoutSeconds", 10, 7200, 600],
  ["start_check_seconds", "startCheckSeconds", 1, 60, 5],
] as const;

describe("The [handoff] table", () => {
  test("every setting has its default without the table", () => {
    expect(validate("")).toEqual({
      handoff: { askForSummary: true, summaryTimeoutSeconds: 120, stopTimeoutSeconds: 30, checkTimeoutSeconds: 600, startCheckSeconds: 5 },
      problems: [],
    });
    expect(validate("[handoff]\n").problems).toEqual([]);
  });

  test("ask_for_summary takes true or false", () => {
    expect(validate("[handoff]\nask_for_summary = false\n").handoff.askForSummary).toBe(false);
    expect(validate('[handoff]\nask_for_summary = "no"\n').problems).toEqual(["handoff.ask_for_summary: must be true or false."]);
  });

  test.each(SETTINGS)("%s accepts its lower and upper bounds", (key, field, low, high) => {
    for (const value of [low, high]) {
      const { handoff, problems } = validate(`[handoff]\n${key} = ${value}\n`);
      expect(problems).toEqual([]);
      expect(handoff[field]).toBe(value);
    }
  });

  test.each(SETTINGS)("%s refuses values outside its range and other types", (key, field, low, high, fallback) => {
    for (const value of [String(low - 1), String(high + 1), `${low}.5`, '"60"']) {
      const { handoff, problems } = validate(`[handoff]\n${key} = ${value}\n`);
      expect(problems).toEqual([`handoff.${key}: must be a whole number from ${low} to ${high}.`]);
      expect(handoff[field]).toBe(fallback);
    }
  });

  test("an unknown key is reported", () => {
    expect(validate('[handoff]\ncolour = "blue"\n').problems).toEqual(["handoff.colour: unknown setting."]);
  });

  test("a wrong value stops a command with exit code 78", async () => {
    const relayHome = makeRelayHome("[handoff]\nsummary_timeout_seconds = 5\n");
    expect(await runRelayInProcess(["status"], { relayHome })).toEqual({
      code: 78,
      stdout: "",
      stderr: `relay: ${join(relayHome, "config.toml")} has 1 problem:\n  handoff.summary_timeout_seconds: must be a whole number from 10 to 900.\nThe settings are described in docs/config.md.\n`,
    });
  });
});
