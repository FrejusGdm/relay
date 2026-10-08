import { describe, expect, test } from "bun:test";
import { CommandError } from "../../src/cli/errors";
import { validateConfig } from "../../src/core/config/validate";
import { parseToml } from "../../src/platform/toml";
import { accountLabel, resolveAccount } from "../../src/handoff/account";

const config = (text: string) => {
  const { config: loaded, problems } = validateConfig(parseToml(text), { relayHome: "/r", homedir: "/h" });
  expect(problems).toEqual([]);
  return loaded;
};
const refused = (arg: string, text: string) => {
  try {
    resolveAccount(arg, config(text));
  } catch (error) {
    expect(error).toBeInstanceOf(CommandError);
    return { code: (error as CommandError).code, lines: (error as CommandError).lines };
  }
  throw new Error("resolveAccount did not refuse");
};

const TWO_CODEX = '[accounts."claude:personal"]\n[accounts."codex:personal"]\n[accounts."codex:work"]\n';

describe("resolveAccount", () => {
  test("a provider with one account resolves to it", () => {
    expect(resolveAccount("codex", config('[accounts."claude:personal"]\n[accounts."codex:personal"]\n')).id).toBe("codex:personal");
  });

  test("a full account name resolves to that account", () => {
    expect(resolveAccount("codex:work", config(TWO_CODEX)).id).toBe("codex:work");
  });

  test("a provider with two accounts and another provider's default is refused", () => {
    expect(refused("codex", `[defaults]\naccount = "claude:personal"\n${TWO_CODEX}`)).toEqual({
      code: 2,
      lines: ["You have two Codex accounts: codex:personal, codex:work. Name one, for example relay switch codex:personal."],
    });
  });

  test("a provider with two accounts uses defaults.account when it belongs to the provider", () => {
    expect(resolveAccount("codex", config(`[defaults]\naccount = "codex:work"\n${TWO_CODEX}`)).id).toBe("codex:work");
  });

  test("a provider without accounts is refused", () => {
    expect(refused("codex", '[accounts."claude:personal"]\n')).toEqual({
      code: 2,
      lines: ["You have no Codex account. Add one with relay account add codex <name>."],
    });
  });

  test("an unknown account is refused", () => {
    expect(refused("codex:home", TWO_CODEX)).toEqual({
      code: 2,
      lines: ["codex:home is not one of your accounts. Add it with relay account add codex home."],
    });
  });

  test.each(["Claude", "cursor:me", "codex:", "codex:Home", "codex:a b", "claude:personal:x", ""])("%p is not an account", (arg) => {
    expect(refused(arg, TWO_CODEX)).toEqual({
      code: 2,
      lines: [`${JSON.stringify(arg)} is not an account. Accounts look like provider:name, for example codex:personal.`],
    });
  });

  test("labels use the adapter's display name and the account name", () => {
    expect(accountLabel({ provider: "claude", name: "personal" })).toBe("Claude Code · personal");
    expect(accountLabel({ provider: "codex", name: "work" })).toBe("Codex · work");
  });
});
