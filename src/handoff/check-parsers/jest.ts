// This parser reads the last complete Tests summary from Jest.
import type { Counts } from "./counts";

export function parseJest(output: string): Counts | null {
  let result: Counts | null = null;
  for (const line of output.split("\n")) {
    if (!/^Tests:[ \t]+\d+ (?:failed|passed|skipped|todo)(?:, \d+ (?:failed|passed|skipped|todo))*, \d+ total[ \t]*$/.test(line)) continue;
    const counts: Counts = { passed: 0, failed: 0, skipped: 0 };
    for (const match of line.matchAll(/(\d+) (failed|passed|skipped|todo)/g)) {
      const [, value, kind] = match;
      if (value === undefined) continue;
      if (kind === "passed") counts.passed += Number(value);
      if (kind === "failed") counts.failed += Number(value);
      if (kind === "skipped" || kind === "todo") counts.skipped += Number(value);
    }
    result = counts;
  }
  return result;
}
