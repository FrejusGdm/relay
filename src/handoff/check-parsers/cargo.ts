// This parser adds the counts from every Cargo test binary's result line.
import type { Counts } from "./counts";

export function parseCargo(output: string): Counts | null {
  const counts: Counts = { passed: 0, failed: 0, skipped: 0 };
  let recognized = false;
  for (const match of output.matchAll(/^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored(?:;[^\n]*)?[ \t]*$/gm)) {
    const [, passed, failed, ignored] = match;
    if (passed === undefined || failed === undefined || ignored === undefined) continue;
    counts.passed += Number(passed);
    counts.failed += Number(failed);
    counts.skipped += Number(ignored);
    recognized = true;
  }
  return recognized ? counts : null;
}
