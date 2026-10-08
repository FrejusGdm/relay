process.env.TZ = "UTC";

import { expect, test } from "bun:test";
import { PROVIDERS } from "../../src/adapters/providers";
import { defineAdapterContract } from "./contract";
import { CONTRACT_ENTRIES } from "./registry";

for (const entry of CONTRACT_ENTRIES) defineAdapterContract(entry);
test("Every registered provider is supported", () => {
  for (const entry of CONTRACT_ENTRIES) expect(PROVIDERS).toContain(entry.provider);
});
