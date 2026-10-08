import { expect, test } from "bun:test";
import { join } from "node:path";

const MODULE = join(import.meta.dir, "..", "..", "src", "core", "cleanup.ts");

// The module keeps one state per process, and an interrupt cannot be undone, so the sequence runs
// in a process of its own.
test("registered actions run once on an interrupt, forgotten ones never, and later ones at once", () => {
  const script = `
    const { onInterrupt, runInterruptActions } = await import(${JSON.stringify(MODULE)});
    const ran = [];
    onInterrupt(() => ran.push("first"));
    onInterrupt(() => { throw new Error("fails"); });
    const forget = onInterrupt(() => ran.push("forgotten"));
    onInterrupt(() => ran.push("last"));
    forget();
    runInterruptActions();
    runInterruptActions();
    onInterrupt(() => ran.push("after"));
    console.log(JSON.stringify(ran));
  `;
  const result = Bun.spawnSync([process.execPath, "-e", script]);
  expect(result.stderr.toString()).toBe("");
  expect(JSON.parse(result.stdout.toString())).toEqual(["first", "last", "after"]);
});
