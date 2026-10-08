// Every relay command that docs/accounts.md shows must exist, with its action and options.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../../src/cli/commands/registry";

const DOC = readFileSync(join(import.meta.dir, "..", "..", "docs", "accounts.md"), "utf8");
const ACTIONS: Record<string, string[]> = { account: ["list", "add", "status", "login", "remove"], policy: ["show"] };
// Commands in code blocks and in inline code that starts with "relay ".
const shown = [
  ...[...DOC.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap((match) => match[1]!.split("\n")),
  ...[...DOC.matchAll(/`(relay [^`]+)`/g)].map((match) => match[1]!),
].map((line) => line.trim()).filter((line) => line.startsWith("relay "));

test("the document shows commands", () => {
  expect(shown.length).toBeGreaterThan(10);
});

test("every command, action and option shown exists", () => {
  for (const line of shown) {
    const words = line.split(/\s+/);
    const def = COMMANDS.find((command) => command.name === words[1]);
    expect(def, line).toBeDefined();
    expect(def!.built, line).toBe(true);
    const actions = ACTIONS[def!.name];
    if (actions !== undefined && words[2] !== undefined && !words[2].startsWith("<")) expect(actions, line).toContain(words[2]);
    for (const word of words.filter((value) => value.startsWith("--"))) {
      const name = word.slice(2).split("=")[0]!;
      expect(def!.options.map((option) => option.name), line).toContain(name);
    }
  }
});
