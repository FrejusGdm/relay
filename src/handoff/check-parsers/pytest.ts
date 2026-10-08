// This parser reads pytest's last timed summary, including quiet output.
import type { Counts } from "./counts";

export function parsePytest(output: string): Counts | null {
  let result: Counts | null = null;
  for (const line of output.split("\n")) {
    if (!/^[ \t]*(?:=+[ \t]*)?\d+ (?:failed|passed|skipped|xfailed|xpassed|errors?|warnings?|deselected)(?:, \d+ (?:failed|passed|skipped|xfailed|xpassed|errors?|warnings?|deselected))* in \d+(?:\.\d+)?s(?: \(\d+:\d{2}:\d{2}\))?[ \t]*(?:=+)?[ \t]*$/.test(line)) continue;
    const counts: Counts = { passed: 0, failed: 0, skipped: 0 };
    for (const match of line.matchAll(/(\d+) (failed|passed|skipped|xfailed|xpassed|errors?|warnings?|deselected)/g)) {
      const [, value, kind] = match;
      if (value === undefined) continue;
      if (kind === "passed" || kind === "xpassed") counts.passed += Number(value);
      if (kind === "failed" || kind === "error" || kind === "errors") counts.failed += Number(value);
      if (kind === "skipped" || kind === "xfailed") counts.skipped += Number(value);
    }
    result = counts;
  }
  return result;
}
