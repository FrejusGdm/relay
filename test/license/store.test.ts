// The saved key file, RELAY_HOME/license.key (add-lifetime-license, design decision 10).
import { expect, test } from "bun:test";
import { chmodSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SettingsError } from "../../src/cli/errors";
import { readLicense, removeLicense, writeLicense } from "../../src/license/store";
import { makeRelayHome } from "../helpers/home";

const uid = process.getuid!();

test("a saved file has mode 0600, even under umask 0o002", () => {
  const relayHome = makeRelayHome();
  const previous = process.umask(0o002);
  try {
    writeLicense(relayHome, "relay1.a.b");
  } finally {
    process.umask(previous);
  }
  const file = join(relayHome, "license.key");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(file, "utf8")).toBe("relay1.a.b\n");
  expect(readLicense(relayHome, uid)).toBe("relay1.a.b");
});

test("the write goes through a temporary file and a rename; a failing rename leaves the old file whole", () => {
  const relayHome = makeRelayHome();
  writeLicense(relayHome, "relay1.old.key");
  const renamed: string[] = [];
  expect(() =>
    writeLicense(relayHome, "relay1.new.key", (from) => {
      renamed.push(String(from));
      throw Object.assign(new Error("rename failed"), { code: "EIO" });
    }),
  ).toThrow("rename failed");
  expect(renamed).toHaveLength(1);
  expect(renamed[0]!.startsWith(join(relayHome, "tmp-license-"))).toBe(true);
  expect(readFileSync(join(relayHome, "license.key"), "utf8")).toBe("relay1.old.key\n");
  expect(readdirSync(relayHome).filter((name) => name.startsWith("tmp-license-"))).toEqual([]);
});

test("a file with mode 0666 gives the relay-config settings error", () => {
  const relayHome = makeRelayHome();
  const file = join(relayHome, "license.key");
  writeFileSync(file, "relay1.a.b\n");
  chmodSync(file, 0o666);
  expect(() => readLicense(relayHome, uid)).toThrow(SettingsError);
  expect(() => readLicense(relayHome, uid)).toThrow(`relay: other users can change ${file}. Run "chmod 600 ${file}" and try again.`);
});

test("removing a missing file succeeds and reports that nothing was saved", () => {
  const relayHome = makeRelayHome();
  expect(removeLicense(relayHome)).toBe(false);
  writeLicense(relayHome, "relay1.a.b");
  expect(removeLicense(relayHome)).toBe(true);
  expect(readLicense(relayHome, uid)).toBeNull();
});
