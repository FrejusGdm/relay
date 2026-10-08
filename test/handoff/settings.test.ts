import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CommandError } from "../../src/cli/errors";
import { handoffSettingsPath, readHandoffSettings, writeHandoffSettings, type HandoffSettings } from "../../src/handoff/settings";

const JOB = "3f9a2c1d";
let relayHome: string;
beforeEach(() => {
  relayHome = join(mkdtempSync(join(realpathSync(tmpdir()), "relay-test-")), "relay-home");
});
afterEach(() => rmSync(dirname(relayHome), { recursive: true, force: true }));

const settings = (next: number): HandoffSettings => ({
  schema_version: 1, job_id: JOB, mode: "interactive", permission: null,
  checks: [{ command: "bun test", timeout_seconds: 600, added_at: "2026-10-07T14:02:11.000Z" }], next_handoff: next,
});

test("a job without the file has no settings", () => {
  expect(readHandoffSettings(relayHome, JOB)).toBeNull();
});

test("settings are written with folder mode 0700 and file mode 0600, and read back", () => {
  writeHandoffSettings(relayHome, settings(1));
  const path = handoffSettingsPath(relayHome, JOB);
  expect(path).toBe(join(relayHome, "jobs", JOB, "handoff-settings.json"));
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
  expect(statSync(join(relayHome, "jobs")).mode & 0o777).toBe(0o700);
  expect(readHandoffSettings(relayHome, JOB)).toEqual(settings(1));
  expect(readdirSync(dirname(path))).toEqual(["handoff-settings.json"]);
});

test("a crash between the write and the rename leaves the old file", () => {
  writeHandoffSettings(relayHome, settings(1));
  const path = handoffSettingsPath(relayHome, JOB);
  const before = readFileSync(path);
  expect(() => writeHandoffSettings(relayHome, settings(2), () => { throw new Error("crash"); })).toThrow("crash");
  expect(readFileSync(path)).toEqual(before);
  expect(readHandoffSettings(relayHome, JOB)?.next_handoff).toBe(1);
  writeHandoffSettings(relayHome, settings(3));
  expect(readHandoffSettings(relayHome, JOB)?.next_handoff).toBe(3);
  expect(existsSync(`${path}.tmp`)).toBe(false);
});

test.each([
  ["not JSON", "{", "it is not valid JSON"],
  ["another job", JSON.stringify({ ...settings(1), job_id: "00000000" }), "a field is missing or has the wrong type"],
  ["a raised ceiling", JSON.stringify({ ...settings(1), mode: "headless", permission: "full-access" }), "a field is missing or has the wrong type"],
  ["an interactive job with a ceiling", JSON.stringify({ ...settings(1), permission: "read-only" }), "a field is missing or has the wrong type"],
  ["a check with two lines", JSON.stringify({ ...settings(1), checks: [{ command: "a\nb", timeout_seconds: 600, added_at: "2026-10-07T14:02:11.000Z" }] }), "a field is missing or has the wrong type"],
])("a damaged file (%s) stops the command with exit code 3", (_name, text, problem) => {
  writeHandoffSettings(relayHome, settings(1));
  const path = handoffSettingsPath(relayHome, JOB);
  writeFileSync(path, text);
  const error = (() => { try { readHandoffSettings(relayHome, JOB); } catch (caught) { return caught; } })() as CommandError;
  expect(error).toBeInstanceOf(CommandError);
  expect([error.code, error.lines]).toEqual([3, [`The job file ${path} is damaged: ${problem}.`]]);
});

test("a file others can write is refused", () => {
  writeHandoffSettings(relayHome, settings(1));
  const path = handoffSettingsPath(relayHome, JOB);
  chmodSync(path, 0o666);
  expect(() => readHandoffSettings(relayHome, JOB)).toThrow(CommandError);
});
