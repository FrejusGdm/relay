// This module cleans terminal output and tries the supported check runners in order.
import { parseBun } from "./bun";
import { parseVitest } from "./vitest";
import { parseJest } from "./jest";
import { parsePytest } from "./pytest";
import { parseCargo } from "./cargo";
import type { Counts } from "./counts";

export type { Counts } from "./counts";

export function parseCounts(output: string): Counts | null {
  const cleaned = output.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "").replace(/\r/g, "");
  for (const parse of [parseBun, parseVitest, parseJest, parsePytest, parseCargo]) {
    const counts = parse(cleaned);
    if (counts !== null) return counts;
  }
  return null;
}
