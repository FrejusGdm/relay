// docs/adapters.md must name every worker event, failure reason, availability state and reading
// source that src/adapters/types.ts defines, so the document cannot fall behind the code.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const DOC = readFileSync(join(ROOT, "docs", "adapters.md"), "utf8");
const TYPES = readFileSync(join(ROOT, "src", "adapters", "types.ts"), "utf8");

function unionMembers(name: string): string[] {
  const match = new RegExp(`export type ${name} =([^;]+);`).exec(TYPES);
  if (match === null) throw new Error(`src/adapters/types.ts has no type ${name}.`);
  return [...match[1]!.matchAll(/"([a-z_-]+)"/g)].map((member) => member[1]!);
}

const EVENT_KINDS = [...TYPES.matchAll(/\{ kind: "([a-z_]+)"/g)].map((match) => match[1]!);

test("the types file has the nine worker events of the provider-adapters spec", () => {
  expect(EVENT_KINDS).toEqual([
    "session_started", "message", "tool", "turn_completed", "turn_failed",
    "limit_update", "approval_needed", "permission_denied", "exited",
  ]);
});

for (const [what, names] of [
  ["worker event", EVENT_KINDS],
  ["failure reason", unionMembers("FailureReason")],
  ["availability state", unionMembers("AvailabilityState")],
  ["reading source", unionMembers("ReadingSource")],
  ["transport", unionMembers("Transport")],
] as const) {
  test(`docs/adapters.md names every ${what}`, () => {
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(DOC).toContain(`| \`${name}\` |`);
  });
}
