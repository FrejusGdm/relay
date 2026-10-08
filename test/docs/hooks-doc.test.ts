// docs/hooks.md must name every event that relay's hooks install, and every field the spool keeps.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createAdapterRegistry } from "../../src/adapters/registry";
import { HOOK_FIELDS } from "../../src/hooks/fields";

const DOC = readFileSync(join(import.meta.dir, "..", "..", "docs", "hooks.md"), "utf8");

test("docs/hooks.md names each event of hookSpec() and the hook file", () => {
  const registry = createAdapterRegistry();
  for (const provider of registry.providers()) {
    const spec = registry.get(provider).hookSpec();
    expect(DOC).toContain(`\`${spec.file}\``);
    for (const event of spec.events) expect(DOC).toContain(`\`${event}\``);
  }
});

test("docs/hooks.md names each field the spool keeps", () => {
  for (const field of HOOK_FIELDS) expect(DOC).toContain(`\`${field}\``);
});
