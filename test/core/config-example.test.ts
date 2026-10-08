import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateConfig } from "../../src/core/config/validate";
import { parseToml } from "../../src/platform/toml";

test("docs/config.example.toml has no problems and three accounts", () => {
  const text = readFileSync(join(import.meta.dir, "..", "..", "docs", "config.example.toml"), "utf8");
  const { config, problems } = validateConfig(parseToml(text), { relayHome: "/r", homedir: "/Users/josue" });
  expect(problems).toEqual([]);
  expect(config.accounts.map((account) => account.id)).toEqual(["claude:personal", "claude:startup", "codex:personal"]);
  expect(config.accounts[1]!.profileDir).toBe("/r/profiles/claude-startup");
  expect(config.projects).toEqual([
    { path: "/Users/josue/projects/relay", allow: ["claude:personal", "codex:personal"] },
  ]);
  expect(config.t3).toEqual({
    url: "http://127.0.0.1:3773/mcp",
    projects: ["/Users/josue/projects/relay"],
    instances: [
      { id: "claude", account: "claude:personal", model: null },
      { id: "codex", account: "codex:personal", model: "gpt-6.1-sol" },
    ],
  });
  expect(config.limits).toEqual([
    { account: "claude:personal", window: "seven_day", threshold: 90, action: null, switchTo: "codex:personal" },
  ]);
});
