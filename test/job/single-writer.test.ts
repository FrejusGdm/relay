// Every event goes through appendEvent (design.md decision 12). This test reads every source file
// and fails if a file other than src/job/events.ts names events.jsonl and can open a file for
// writing.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..", "..", "src");
const WRITER = "job/events.ts";

const WRITES = [
  /\b(write|append)File(Sync)?\b/,
  /\bwriteSync\b/,
  /\bcreateWriteStream\b/,
  /\bBun\s*\.\s*write\b/,
  /\bO_(WRONLY|RDWR|APPEND|CREAT|TRUNC)\b/,
  /\bopen(Sync)?\s*\([^;]*["'`][wa]\+?x?["'`]/,
  /\.writer\s*\(/,
];

function writesEvents(text: string): boolean {
  return text.includes("events.jsonl") && WRITES.some((pattern) => pattern.test(text));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name) ? [path] : [];
  });
}

test("no source file other than src/job/events.ts opens events.jsonl for writing", () => {
  const offenders = sourceFiles(SRC)
    .filter((file) => relative(SRC, file) !== WRITER && writesEvents(readFileSync(file, "utf8")))
    .map((file) => relative(SRC, file));
  expect(offenders).toEqual([]);
});

test("the writer itself is found by the check", () => {
  expect(writesEvents(readFileSync(join(SRC, WRITER), "utf8"))).toBe(true);
});

test.each([
  'appendFileSync(join(dir, "events.jsonl"), line);',
  'writeFileSync(".relay/events.jsonl", "");',
  'await Bun.write(".relay/events.jsonl", text);',
  'const fd = openSync(join(relayDir, "events.jsonl"), "a");',
  'openSync(path + "/events.jsonl", constants.O_WRONLY | constants.O_APPEND);',
  'createWriteStream(".relay/events.jsonl", { flags: "a" });',
])("the check finds %s", (line) => {
  expect(writesEvents(line)).toBe(true);
});

test("naming the file without writing it is allowed", () => {
  expect(writesEvents('const files = [".relay/task.md", ".relay/events.jsonl"];')).toBe(false);
});
