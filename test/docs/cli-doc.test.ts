// docs/cli.md documents every command with the usage line its help shows, and the exit codes of
// the commands add-provider-adapters builds (task 9.9).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../../src/cli/commands/registry";
import { renderCommandHelp } from "../../src/cli/help";
import { ExitCode } from "../../src/cli/exit-codes";

const doc = readFileSync(join(import.meta.dir, "..", "..", "docs", "cli.md"), "utf8");

test("each command's help shows the usage line of its row in docs/cli.md", () => {
  const rows = new Map<string, string>();
  for (const match of doc.matchAll(/^\| `([a-z-]+)` \| `(relay [^`]*)` \|/gm)) rows.set(match[1]!, match[2]!.replaceAll("\\|", "|"));
  expect([...rows.keys()].sort()).toEqual(COMMANDS.map((def) => def.name).sort());
  for (const def of COMMANDS) {
    const usage = renderCommandHelp(def).split("\n")[1]!.trim();
    expect(usage).toBe(rows.get(def.name)!);
  }
});

test("docs/cli.md lists the exit codes of run, account, hooks, policy show and providers", () => {
  const codes = new Set<number>(Object.values(ExitCode));
  for (const command of ["relay run", "relay account", "relay hooks", "relay policy show", "relay providers"]) {
    const row = new RegExp(`^\\| \`${command}\` \\| (.+) \\|$`, "m").exec(doc);
    expect(row).not.toBeNull();
    const listed = [...row![1]!.matchAll(/(?:^|; )(\d+) /g)].map((match) => Number(match[1]));
    expect(listed.length).toBeGreaterThan(0);
    for (const code of listed) expect(codes.has(code)).toBe(true);
  }
});
