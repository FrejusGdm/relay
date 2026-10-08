import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ExitCode } from "../../src/cli/exit-codes";

test("the exit-code table in docs/cli.md matches ExitCode", () => {
  const doc = readFileSync(join(import.meta.dir, "..", "..", "docs", "cli.md"), "utf8");
  const rows: Record<string, number> = {};
  for (const match of doc.matchAll(/^\| (\d+) \| `(\w+)` \|/gm)) rows[match[2]!] = Number(match[1]);
  expect(rows).toEqual({ ...ExitCode });
});
