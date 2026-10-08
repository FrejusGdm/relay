import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../../src/cli/commands/registry";
import { renderCommandHelp, renderTopHelp } from "../../src/cli/help";
import { WITH_UNBUILT } from "../helpers/cli";

const golden = (name: string) => readFileSync(join(import.meta.dir, "golden", `${name}.txt`), "utf8");
const LOG_LEVEL_ROW = "      --log-level <level>  How much to log: debug, info, warn or error";

test("the top-level help equals top-help.txt byte for byte", () => {
  expect(renderTopHelp(COMMANDS)).toBe(golden("top-help"));
});

describe("command help", () => {
  test.each(COMMANDS.map((def) => [def.name, def] as const))("%s equals its golden file", (name, def) => {
    expect(renderCommandHelp(def)).toBe(golden(name));
  });
});

test("every output ends with exactly one newline", () => {
  for (const text of [renderTopHelp(COMMANDS), ...COMMANDS.map(renderCommandHelp)]) {
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  }
});

test("command rows use padEnd(20)", () => {
  const lines = renderTopHelp(COMMANDS).split("\n");
  for (const def of COMMANDS) expect(lines).toContain("  " + def.name.padEnd(20) + def.summary);
});

test("option rows use padEnd(23)", () => {
  expect(renderTopHelp(COMMANDS).split("\n")).toContain(LOG_LEVEL_ROW);
  for (const def of COMMANDS) {
    const lines = renderCommandHelp(def).split("\n");
    expect(lines).toContain("  " + "-h, --help".padEnd(23) + "  Show this help");
    expect(lines).toContain(LOG_LEVEL_ROW);
    for (const option of def.options) {
      const long = `--${option.name}${option.value ? ` ${option.value}` : ""}`;
      const left = option.short ? `-${option.short}, ${long}` : `    ${long}`;
      expect(lines).toContain("  " + left.padEnd(23) + "  " + option.description);
    }
  }
});

test("the help of each command that is not built yet ends with the not-built line", () => {
  // The test-only command keeps this check from passing on an empty list once every command is built.
  for (const def of WITH_UNBUILT.filter((def) => !def.built)) {
    expect(renderCommandHelp(def).endsWith("\n\nNot built yet. This version only reads your settings.\n")).toBe(true);
  }
});

test("docs/cli.md has every usage line from registry.ts", () => {
  const doc = readFileSync(join(import.meta.dir, "..", "..", "docs", "cli.md"), "utf8").replaceAll("\\|", "|");
  const missing = COMMANDS.filter((def) => !doc.includes(`\`${def.usage}\``)).map((def) => def.usage);
  expect(missing).toEqual([]);
});
