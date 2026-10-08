// docs/handoff.md shows example outputs of relay switch (task 6.4). This test runs the command
// tests with RELAY_DOC_SAMPLES=1 and fails when an example in the page differs from what relay
// prints. Checkpoint IDs differ from run to run, so six-character IDs are compared as one value.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const normalize = (text: string) => text.replace(/\b[0-9a-f]{6}\b/g, "<checkpoint>").trimEnd();

test("every example block in docs/handoff.md is an output relay printed", async () => {
  const child = Bun.spawn([process.execPath, "test", "test/cli/switch.test.ts"], {
    cwd: ROOT, env: { ...process.env, RELAY_DOC_SAMPLES: "1" }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(await child.exited).toBe(0);
  const samples = new Set([...`${stdout}\n${stderr}`.matchAll(/^SAMPLE (\$ relay [^\n]*\n[\s\S]*?)\nEND$/gm)].map((match) => normalize(match[1]!)));
  expect(samples.size).toBeGreaterThan(5);
  const doc = readFileSync(join(ROOT, "docs", "handoff.md"), "utf8");
  const examples = [...doc.matchAll(/^```\n(\$ relay [\s\S]*?)\n```$/gm)].map((match) => normalize(match[1]!));
  expect(examples.length).toBeGreaterThan(3);
  expect(examples.filter((example) => !samples.has(example))).toEqual([]);
}, 180_000);
