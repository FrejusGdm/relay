import { expect, test } from "bun:test";
import { createAdapterRegistry } from "../../src/adapters/registry";
import { createFakeAdapter } from "../fakes/fake-adapter";

test("the default registry has exactly claude and codex", () => {
  expect(createAdapterRegistry().providers()).toEqual(["claude", "codex"]);
});

test("an override replaces one provider and leaves the other", () => {
  const fake = createFakeAdapter({ provider: "claude" });
  const registry = createAdapterRegistry({ claude: fake });
  expect(registry.get("claude")).toBe(fake);
  expect(registry.providers()).toEqual(["claude", "codex"]);
  expect(registry.get("codex").displayName).toBe("Codex");
});
