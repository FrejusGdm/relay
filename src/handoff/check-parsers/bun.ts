// This parser reads Bun's final pass, fail and skip summary lines.
import type { Counts } from "./counts";

export function parseBun(output: string): Counts | null {
  const counts: Counts = { passed: 0, failed: 0, skipped: 0 };
  let recognized = false;
  for (const match of output.matchAll(/^[ \t]*(\d+) (pass|fail|skip)[ \t]*$/gm)) {
    const [, value, kind] = match;
    if (value === undefined) continue;
    if (kind === "pass") counts.passed = Number(value);
    if (kind === "fail") counts.failed = Number(value);
    if (kind === "skip") counts.skipped = Number(value);
    if (kind === "pass" || kind === "fail") recognized = true;
  }
  return recognized ? counts : null;
}
