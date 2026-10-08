process.env.TZ = "UTC";

import { expect, test } from "bun:test";
import { PROVIDERS } from "../../src/adapters/providers";
import { defineAdapterContract } from "./contract";
import { CONTRACT_ENTRIES } from "./registry";

for (const entry of CONTRACT_ENTRIES) defineAdapterContract(entry);
test("Every registered provider is supported", () => {
  for (const entry of CONTRACT_ENTRIES) expect(PROVIDERS).toContain(entry.provider);
});

// Marked as failing until tasks 7.1 and 8.2 register the Claude Code and Codex adapters in
// test/adapters/registry.ts. Once both are there, this test passes, test.failing reports that as
// an error, and the mark must be removed, so a provider without contract tests cannot go unnoticed.
test.failing("Every provider has a contract entry", () => {
  const covered = new Set(CONTRACT_ENTRIES.map((entry) => entry.provider));
  expect(PROVIDERS.filter((provider) => !covered.has(provider))).toEqual([]);
});
