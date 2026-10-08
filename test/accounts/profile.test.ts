import { expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { checkProfileFolder, displayPath, ensureProfileFolder, ProfileError } from "../../src/accounts/profile";
import { makeRelayHome } from "../helpers/home";
import { fakeEnv } from "../helpers/fake-programs";
import { runRelayInProcess } from "../helpers/cli";

const HOME = process.env.HOME!;
const UID = process.getuid!();
const mode = (path: string) => lstatSync(path).mode & 0o777;

test("relay creates the profile folder and profiles/ with mode 0700", () => {
  const relayHome = makeRelayHome();
  const dir = join(relayHome, "profiles", "claude-work");
  expect(ensureProfileFolder(dir, relayHome, UID, HOME)).toBe(true);
  expect(mode(join(relayHome, "profiles"))).toBe(0o700);
  expect(mode(dir)).toBe(0o700);
  expect(ensureProfileFolder(dir, relayHome, UID, HOME)).toBe(false);
});

test("a folder relay did not create keeps its mode", () => {
  const dir = mkdtempSync(join(HOME, "own-profile-"));
  chmodSync(dir, 0o755);
  expect(ensureProfileFolder(dir, makeRelayHome(), UID, HOME)).toBe(false);
  expect(mode(dir)).toBe(0o755);
});

test("a folder others can change is refused with the chmod hint", () => {
  const dir = mkdtempSync(join(HOME, "open-profile-"));
  chmodSync(dir, 0o777);
  expect(() => checkProfileFolder(dir, UID, HOME)).toThrow(
    new ProfileError(`Other users can change ${displayPath(dir, HOME)}. Run chmod 700 on it, then try again.`),
  );
  expect(mode(dir)).toBe(0o777);
});

test("a folder of another user is refused", () => {
  const dir = mkdtempSync(join(HOME, "other-profile-"));
  expect(() => checkProfileFolder(dir, UID + 1, HOME)).toThrow("belongs to another user. relay only uses a profile folder you own.");
});

test("a symbolic link is refused", () => {
  const target = mkdtempSync(join(HOME, "target-"));
  const link = join(HOME, `linked-profile-${process.pid}`);
  symlinkSync(target, link);
  expect(() => checkProfileFolder(link, UID, HOME)).toThrow(`${displayPath(link, HOME)} is a symbolic link.`);
  expect(() => ensureProfileFolder(link, makeRelayHome(), UID, HOME)).toThrow(ProfileError);
});

test("paths under the home folder are shown with ~", () => {
  expect(displayPath(join(HOME, ".relay", "profiles", "claude-work"), HOME)).toBe("~/.relay/profiles/claude-work");
  expect(displayPath("/opt/profile", HOME)).toBe("/opt/profile");
});

test("relay account status on a profile folder others can change exits 78", async () => {
  const relayHome = makeRelayHome('[accounts."claude:work"]\n');
  const dir = join(relayHome, "profiles", "claude-work");
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o777);
  const { code, stderr } = await runRelayInProcess(["account", "status", "claude:work"], { relayHome, env: fakeEnv() });
  expect(code).toBe(78);
  expect(stderr).toBe(`Other users can change ${displayPath(dir, HOME)}. Run chmod 700 on it, then try again.\n`);
});
