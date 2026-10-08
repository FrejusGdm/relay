// scripts/keygen.ts (add-lifetime-license, design decision 13), run in a temporary folder.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "..", "scripts", "keygen.ts");
const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function keygen(kid: string, cwd: string) {
  const result = Bun.spawnSync([process.execPath, script, kid], { cwd, env: { PATH: process.env.PATH ?? "" } });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function folder(): string {
  const path = mkdtempSync(join(tmpdir(), "relay-keygen-"));
  folders.push(path);
  return path;
}

test("writes live-1.signing-key with mode 0600 and prints only the public key line", () => {
  const cwd = folder();
  const result = keygen("live-1", cwd);
  expect(result.code).toBe(0);
  const file = join(cwd, "live-1.signing-key");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(result.stdout).toMatch(/^"live-1": "[A-Za-z0-9_-]{43}", \/\/ gitleaks:allow\n$/);
  const privateKey = readFileSync(file, "utf8").trim();
  expect(privateKey.length).toBeGreaterThan(40);
  expect(result.stdout).not.toContain(privateKey);
  expect(result.stderr).not.toContain(privateKey);
});

test("a second run refuses to overwrite the file", () => {
  const cwd = folder();
  expect(keygen("live-1", cwd).code).toBe(0);
  const before = readFileSync(join(cwd, "live-1.signing-key"), "utf8");
  const second = keygen("live-1", cwd);
  expect(second.code).toBe(1);
  expect(second.stdout).toBe("");
  expect(second.stderr).toContain("already exists");
  expect(readFileSync(join(cwd, "live-1.signing-key"), "utf8")).toBe(before);
});

test("a key ID that is not test-<n> or live-<n> is refused", () => {
  const cwd = folder();
  const result = keygen("prod", cwd);
  expect(result.code).toBe(2);
  expect(result.stdout).toBe("");
  expect(statSync(join(cwd, "prod.signing-key"), { throwIfNoEntry: false })).toBeUndefined();
});
