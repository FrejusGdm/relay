import { describe, expect, test } from "bun:test";
import { emptyConfig, validateConfig } from "../../src/core/config/validate";
import { parseToml } from "../../src/platform/toml";
import { runRelayInProcess } from "../helpers/cli";
import { makeRelayHome } from "../helpers/home";

const ctx = { relayHome: "/r", homedir: "/Users/josue" };
const validate = (text: string) => {
  const { config, problems } = validateConfig(parseToml(text), ctx);
  return { config, problems: problems.map(({ key, message }) => `${key}: ${message}`) };
};
const accounts = '\n[accounts."claude:personal"]\n[accounts."claude:work"]\n[accounts."claude:home"]\n[accounts."codex:personal"]\n[accounts."codex:work"]\n';
const key = 'limits."claude:personal".seven_day';
const rule = (settings: string) => validate(`[${key}]\n${settings}${accounts}`);

describe("Rule settings", () => {
  test.each([
    [`[${key}]\nthreshold = 120`, `${key}.threshold: must be a whole number from 1 to 100.`],
    ['[limits."claude:personal".monthly]', 'limits."claude:personal".monthly: unknown window. Use five_hour or seven_day.'],
    ['[limits."claude:work".seven_day]\nswitch_to = "claude:home"',
      'limits."claude:work".seven_day.switch_to: relay does not move work between two Claude accounts on its own. Anthropic\'s terms say plan limits assume ordinary, individual use.'],
    [`[${key}]\naction = "switch"`, `${key}.switch_to: is required when action is "switch".`],
    [`[${key}]\nswitch_to = "codex:personal"`,
      `${key}.switch_to: T3 Code has no provider mapped to codex:personal. Run relay t3 connect to map it.`],
  ])("the CLI reports a settings problem with exit code 78: %s", async (text, problem) => {
    const result = await runRelayInProcess(["status"], { relayHome: makeRelayHome(`${text}${accounts}`) });
    expect(result.code).toBe(78);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`  ${problem}\n`);
  });

  test("limits are empty by default and missing keys are null", () => {
    expect(emptyConfig("/r").limits).toEqual([]);
    expect(validate("").config.limits).toEqual([]);
    expect(rule("").config.limits).toEqual([
      { account: "claude:personal", window: "seven_day", threshold: null, action: null, switchTo: null },
    ]);
  });

  test.each(["120", "0", "-1", "1.5", '"90"'])("threshold = %s is invalid", (value) => {
    expect(rule(`threshold = ${value}`).problems).toEqual([`${key}.threshold: must be a whole number from 1 to 100.`]);
  });

  test.each([1, 100])("threshold %s is accepted", (threshold) => {
    const result = rule(`threshold = ${threshold}\naction = "notify"`);
    expect(result.problems).toEqual([]);
    expect(result.config.limits[0]!.threshold).toBe(threshold);
  });

  test("an unknown window", () => {
    expect(validate(`[limits."claude:personal".monthly]${accounts}`).problems).toEqual([
      'limits."claude:personal".monthly: unknown window. Use five_hour or seven_day.',
    ]);
  });

  test("an unknown action and key follow file order", () => {
    expect(rule('action = "maybe"\nconstructor = 3').problems).toEqual([
      `${key}.action: must be "wait", "switch" or "notify".`, `${key}.constructor: unknown setting.`,
    ]);
  });

  test("an undefined limits account and a malformed name", () => {
    expect(validate('[limits."codex:missing".seven_day]').problems).toEqual([
      'limits."codex:missing": "codex:missing" is not one of your accounts.',
    ]);
    expect(validate('[limits."BAD".seven_day]').problems).toEqual([
      'limits.BAD: account names look like provider:name in lowercase, for example "claude:personal".',
    ]);
  });

  test("every limits level must be a table", () => {
    expect(validate("limits = 3").problems).toEqual(["limits: must be a table."]);
    expect(validate(`[limits]\n"claude:personal" = 3${accounts}`).problems).toEqual([
      'limits."claude:personal": must be a table.',
    ]);
    expect(validate(`[limits."claude:personal"]\nseven_day = 3${accounts}`).problems).toEqual([
      `${key}: must be a table.`,
    ]);
  });
});

describe("Switch targets are checked", () => {
  test("two Claude accounts are refused", () => {
    expect(validate(`[limits."claude:work".seven_day]\nswitch_to = "claude:home"${accounts}`).problems).toEqual([
      'limits."claude:work".seven_day.switch_to: relay does not move work between two Claude accounts on its own. Anthropic\'s terms say plan limits assume ordinary, individual use.',
    ]);
  });

  test("two Codex accounts are refused", () => {
    expect(validate(`[limits."codex:personal".seven_day]\nswitch_to = "codex:work"${accounts}`).problems).toEqual([
      'limits."codex:personal".seven_day.switch_to: relay does not move work between two Codex accounts on its own. OpenAI\'s terms forbid getting around rate limits.',
    ]);
  });

  test("switch requires a target", () => {
    expect(rule('action = "switch"').problems).toEqual([`${key}.switch_to: is required when action is "switch".`]);
  });

  test("a target must be mapped in T3", () => {
    expect(rule('switch_to = "codex:personal"').problems).toEqual([
      `${key}.switch_to: T3 Code has no provider mapped to codex:personal. Run relay t3 connect to map it.`,
    ]);
  });

  test.each(['"codex:missing"', '"BAD"', "3"])("switch_to = %s uses accountRef and string checks", (value) => {
    const message = value === "3" ? "must be a string." : value === '"BAD"'
      ? 'account names look like provider:name in lowercase, for example "claude:personal".'
      : '"codex:missing" is not one of your accounts.';
    expect(rule(`action = "switch"\nswitch_to = ${value}`).problems).toEqual([`${key}.switch_to: ${message}`]);
  });

  test("a limits table before t3 and accounts still resolves the target", () => {
    const { config, problems } = validate(`[${key}]
threshold = 85
action = "switch"
switch_to = "codex:personal"
[t3.instances.codex]
account = "codex:personal"
${accounts}`);
    expect(problems).toEqual([]);
    expect(config.limits).toEqual([
      { account: "claude:personal", window: "seven_day", threshold: 85, action: "switch", switchTo: "codex:personal" },
    ]);
  });

  test("target checks run after the file walk even for an ignored target", () => {
    expect(rule('action = "wait"\nswitch_to = "codex:personal"\ncolour = 3').problems).toEqual([
      `${key}.colour: unknown setting.`,
      `${key}.switch_to: T3 Code has no provider mapped to codex:personal. Run relay t3 connect to map it.`,
    ]);
  });
});
