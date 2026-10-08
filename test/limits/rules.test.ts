import { describe, expect, test } from "bun:test";
import { validateConfig } from "../../src/core/config/validate";
import { describeRule, resolveLimitRules, windowWords } from "../../src/limits/rules";
import { parseToml } from "../../src/platform/toml";

const ctx = { relayHome: "/r", homedir: "/Users/josue" };
const rulesOf = (text: string) => {
  const { config, problems } = validateConfig(parseToml(text), ctx);
  expect(problems).toEqual([]);
  return resolveLimitRules(config);
};
const accounts = '\n[accounts."claude:personal"]\n[accounts."codex:personal"]\n';
const mappings = '\n[t3.instances.claude]\naccount = "claude:personal"\n[t3.instances.codex]\naccount = "codex:personal"\n';

describe("Limit rules", () => {
  test("a mapped account with no rules uses both defaults", () => {
    const rules = rulesOf(`${accounts}\n[t3.instances.claude]\naccount = "claude:personal"`);
    expect(rules.map(describeRule)).toEqual([
      "claude:personal · five_hour: wait at 100%", "claude:personal · seven_day: notify at 90%",
    ]);
  });

  test("only a weekly target defaults to switch at 90 percent", () => {
    const rules = rulesOf(`[limits."claude:personal".seven_day]\nswitch_to = "codex:personal"${accounts}${mappings}`);
    expect(describeRule(rules[1]!)).toBe("claude:personal · seven_day: switch to codex:personal at 90%");
    expect(rules[1]!.switchToIgnored).toBe(false);
  });

  test("every explicit key wins over defaults", () => {
    const rules = rulesOf(`[limits."claude:personal".five_hour]
threshold = 75
action = "switch"
switch_to = "codex:personal"${accounts}${mappings}`);
    expect(rules[0]).toEqual({
      account: "claude:personal", window: "five_hour", threshold: 75, action: "switch",
      switchTo: "codex:personal", switchToIgnored: false,
    });
    expect(describeRule(rules[0]!)).toBe("claude:personal · five_hour: switch to codex:personal at 75%");
  });

  test.each(["wait", "notify"])("%s with a target reports that it is ignored", (action) => {
    const rules = rulesOf(`[limits."claude:personal".seven_day]
action = "${action}"
switch_to = "codex:personal"${accounts}${mappings}`);
    expect(rules[1]!.switchToIgnored).toBe(true);
    expect(describeRule(rules[1]!)).toBe(`claude:personal · seven_day: ${action} at 90% (switch_to is ignored)`);
  });

  test("a 5-hour target alone retains wait and is ignored", () => {
    const rules = rulesOf(`[limits."claude:personal".five_hour]\nswitch_to = "codex:personal"${accounts}${mappings}`);
    expect(describeRule(rules[0]!)).toBe("claude:personal · five_hour: wait at 100% (switch_to is ignored)");
  });

  test("account order wins over limits and instance order, with 5-hour first", () => {
    const rules = rulesOf(`[limits."claude:personal".seven_day]\nthreshold = 80
[limits."claude:personal".five_hour]\nthreshold = 95
[t3.instances.claude]\naccount = "claude:personal"
[t3.instances.codex]\naccount = "codex:personal"
[accounts."codex:personal"]
[accounts."claude:personal"]
[accounts."claude:unused"]`);
    expect(rules.map(describeRule)).toEqual([
      "codex:personal · five_hour: wait at 100%", "codex:personal · seven_day: notify at 90%",
      "claude:personal · five_hour: wait at 95%", "claude:personal · seven_day: notify at 80%",
    ]);
  });

  test("an unmapped account with a limits table gets defaults for missing windows", () => {
    expect(rulesOf(`[limits."claude:personal".seven_day]\nthreshold = 80${accounts}`).map(describeRule)).toEqual([
      "claude:personal · five_hour: wait at 100%", "claude:personal · seven_day: notify at 80%",
    ]);
    expect(rulesOf(`[limits."claude:personal"]${accounts}`).map(describeRule)).toEqual([
      "claude:personal · five_hour: wait at 100%", "claude:personal · seven_day: notify at 90%",
    ]);
    expect(rulesOf(accounts)).toEqual([]);
  });

  test("human window words", () => {
    expect(windowWords("five_hour")).toBe("5-hour");
    expect(windowWords("seven_day")).toBe("weekly");
  });
});
