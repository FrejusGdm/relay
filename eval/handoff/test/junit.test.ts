import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readJunit } from "../src/junit.ts";

const data = join(import.meta.dir, "data", "junit");
const folders: string[] = [];
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("Bun reports failures, skipped tests, and decoded names", async () => {
  expect(await readJunit(join(data, "bun-mixed.xml"))).toEqual({
    passed: 2, failed: 3, total: 5, failing: ['bad <one> & "q"', "skipped", "later"], missing: 0, extra: 0,
  });
});

test("Missing Bun test results count as failures", async () => {
  expect(await readJunit(join(data, "bun-load-error.xml"), 3)).toEqual({
    passed: 2, failed: 1, total: 3, failing: [], missing: 1, extra: 0,
  });
});

test("Bun results without an expected total include only reported tests", async () => {
  expect(await readJunit(join(data, "bun-load-error.xml"))).toEqual({
    passed: 2, failed: 0, total: 2, failing: [], missing: 0, extra: 0,
  });
});

test("Python reports failures, errors, and skipped tests", async () => {
  expect(await readJunit(join(data, "python-mixed.xml"))).toEqual({
    passed: 2, failed: 3, total: 5, failing: ["test_errors", "test_fails", "test_skipped"], missing: 0, extra: 0,
  });
});

test("Python module import errors appear as failed tests", async () => {
  expect(await readJunit(join(data, "python-load-error.xml"), 3)).toEqual({
    passed: 2, failed: 1, total: 3, failing: ["test_broken"], missing: 0, extra: 0,
  });
});

test("An absent report counts every expected test as missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-eval-junit-"));
  folders.push(dir);
  expect(await readJunit(join(dir, "absent.xml"), 4)).toEqual({
    passed: 0, failed: 4, total: 4, failing: [], missing: 4, extra: 0,
  });
});

test("The Python runner imports project packages and writes results", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-eval-junit-"));
  folders.push(dir);
  mkdirSync(join(dir, "pkg"));
  mkdirSync(join(dir, "tests"));
  writeFileSync(join(dir, "pkg", "__init__.py"), "def double(x): return 2 * x\n");
  writeFileSync(join(dir, "tests", "test_double.py"), `import unittest
from pkg import double

class DoubleTests(unittest.TestCase):
    def test_passes(self):
        self.assertEqual(double(2), 4)

    def test_fails(self):
        self.assertEqual(double(2), 5)
`);
  const report = join(dir, "out.xml");
  const runner = resolve(import.meta.dir, "..", "runners", "unittest_junit.py");
  const child = Bun.spawn(["python3", runner, report, "tests"], {
    cwd: dir, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [exitCode] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(exitCode).toBe(1);
  expect(await readJunit(report)).toEqual({
    passed: 1, failed: 1, total: 2, failing: ["test_fails"], missing: 0, extra: 0,
  });
});

test("Tests beyond the expected total are reported as extra", async () => {
  expect(await readJunit(join(data, "bun-mixed.xml"), 3)).toMatchObject({ total: 5, missing: 0, extra: 2 });
});

async function variant(edit: (text: string) => string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "relay-eval-junit-"));
  folders.push(dir);
  const path = join(dir, "report.xml");
  writeFileSync(path, edit(readFileSync(join(data, "bun-mixed.xml"), "utf8")));
  return path;
}

test("A report cut short after a test case start counts as no results", async () => {
  const path = await variant((text) => text.slice(0, text.indexOf("<testcase") + text.slice(text.indexOf("<testcase")).indexOf(">") + 1));
  expect(await readJunit(path, 5)).toEqual({ passed: 0, failed: 5, total: 5, failing: [], missing: 5, extra: 0 });
});

test("A report whose root counts disagree with its test cases counts as no results", async () => {
  const path = await variant((text) => text.replace('<testsuites name="bun test" tests="5"', '<testsuites name="bun test" tests="4"'));
  expect(await readJunit(path)).toEqual({ passed: 0, failed: 0, total: 0, failing: [], missing: 0, extra: 0 });
  const failures = await variant((text) => text.replace('assertions="2" failures="1" skipped="2" time="0.0', 'assertions="2" failures="0" skipped="2" time="0.0'));
  expect((await readJunit(failures)).total).toBe(0);
});
