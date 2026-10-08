// The license-command spec: every scenario of "License command", "Activating a license", "License
// status", "Removing a license", "Public key table from the command context", "Builds without a
// public key", "One list of paid features" and "Key not logged". The key pairs are made while the
// tests run and passed in through the licensePublicKeys option.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { licenseCommand } from "../../src/cli/commands/license";
import { COMMANDS } from "../../src/cli/commands/registry";
import { PAID_FEATURES } from "../../src/license/features";
import { runRelay, runRelayInProcess } from "../helpers/cli";
import { makeRelayHome } from "../helpers/home";
import { keyPair, licenseKey, table } from "../license/keys";

const golden = readFileSync(join(import.meta.dir, "golden", "license.txt"), "utf8");
const live = keyPair("live-1");
const keys = table(live);
const KEY = licenseKey(live);

function run(args: string[], options: Parameters<typeof runRelayInProcess>[1] = {}) {
  return runRelayInProcess(["license", ...args], { licensePublicKeys: keys, ...options });
}

function saved(relayHome: string, key: string, mode = 0o600): string {
  const file = join(relayHome, "license.key");
  writeFileSync(file, `${key}\n`);
  chmodSync(file, mode);
  return file;
}

describe("License command", () => {
  test("an unknown action is a usage error", async () => {
    expect(await run(["show"])).toEqual({
      code: 2,
      stdout: "",
      stderr: 'relay: license needs activate, status or remove, not "show".\n',
    });
  });

  test("a second argument after status is a usage error", async () => {
    expect(await run(["status", "relay1.abc"])).toEqual({
      code: 2,
      stdout: "",
      stderr: "relay: license status takes no other argument.\n",
    });
    expect((await run(["remove", "x"])).stderr).toBe("relay: license remove takes no other argument.\n");
  });

  test("relay license --help prints the golden help", async () => {
    expect(await run(["--help"])).toEqual({ code: 0, stdout: golden, stderr: "" });
  });
});

describe("Activating a license", () => {
  test("a valid key is saved with mode 0600", async () => {
    const relayHome = makeRelayHome();
    const file = join(relayHome, "license.key");
    expect(await run(["activate", KEY], { relayHome })).toEqual({
      code: 0,
      stdout: [
        "License activated.",
        "License ID: 3f9a2c1d5e7b9a01",
        "Issued: 2026-10-07",
        `relay keeps the key in ${file} and checks it on this computer only.`,
        "",
      ].join("\n"),
      stderr: "",
    });
    expect(readFileSync(file, "utf8")).toBe(`${KEY}\n`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(relayHome).filter((name) => name.startsWith("tmp-license-"))).toEqual([]);
  });

  test("a key from standard input is saved", async () => {
    const relayHome = makeRelayHome();
    const result = await run(["activate"], { relayHome, stdin: `${KEY}\n` });
    expect(result.code).toBe(0);
    expect(readFileSync(join(relayHome, "license.key"), "utf8")).toBe(`${KEY}\n`);
  });

  test("no key at a terminal is a usage error", async () => {
    expect(await run(["activate"], { answers: [] })).toEqual({
      code: 2,
      stdout: "",
      stderr: 'relay: license activate needs a key. Run "relay license activate <key>", or pipe the key into it.\n',
    });
  });

  test("a key for another license replaces the saved one", async () => {
    const relayHome = makeRelayHome();
    saved(relayHome, licenseKey(live, "aaaaaaaaaaaaaaaa"));
    const result = await run(["activate", licenseKey(live, "bbbbbbbbbbbbbbbb")], { relayHome });
    expect(result.code).toBe(0);
    expect(result.stdout.split("\n")[0]).toBe("License activated. It replaces license aaaaaaaaaaaaaaaa.");
  });

  test("activating the same license again does not say it replaces one", async () => {
    const relayHome = makeRelayHome();
    saved(relayHome, KEY);
    expect((await run(["activate", KEY], { relayHome })).stdout.split("\n")[0]).toBe("License activated.");
  });

  test("an invalid key saves nothing and exits with 50", async () => {
    const relayHome = makeRelayHome();
    expect(await run(["activate", "hello"], { relayHome })).toEqual({
      code: 50,
      stdout: "",
      stderr: 'relay: this is not a relay license key. Copy the whole key; it starts with "relay1.".\n',
    });
    expect(existsSync(join(relayHome, "license.key"))).toBe(false);
  });

  test("a correctly signed test key exits with 50 and the test-mode message", async () => {
    const testPair = keyPair("test-1");
    expect(await run(["activate", licenseKey(testPair)], { licensePublicKeys: table(live, testPair) })).toEqual({
      code: 50,
      stdout: "",
      stderr: "relay: this license key comes from Stripe test mode and does not unlock relay.\n",
    });
  });

  test("the other problems print their own reasons", async () => {
    expect((await run(["activate", licenseKey(keyPair("live-7"))])).stderr).toBe(
      "relay: this license key was signed with a key that this version of relay does not know. Update relay and try again.\n",
    );
    expect((await run(["activate", licenseKey(keyPair("live-1"))])).stderr).toBe(
      "relay: this license key failed its signature check. Copy it again from your license page.\n",
    );
  });
});

describe("License status", () => {
  test("an active license with no paid features yet", async () => {
    const relayHome = makeRelayHome();
    saved(relayHome, KEY);
    expect(await run(["status"], { relayHome })).toEqual({
      code: 0,
      stdout: "License: active\nLicense ID: 3f9a2c1d5e7b9a01\nIssued: 2026-10-07\nPaid features: none yet\n",
      stderr: "",
    });
  });

  test("no license exits with 51", async () => {
    expect(await run(["status"])).toEqual({
      code: 51,
      stdout: "License: none\nrelay's core is free and stays free. A license unlocks the paid features.\nPaid features: none yet\n",
      stderr: "",
    });
  });

  test("a saved key whose signature check fails exits with 50", async () => {
    const relayHome = makeRelayHome();
    const [prefix, payload, signature] = KEY.split(".") as [string, string, string];
    const damaged = `${prefix}.${payload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    const file = saved(relayHome, damaged);
    expect(await run(["status"], { relayHome })).toEqual({
      code: 50,
      stdout: "",
      stderr:
        `relay: the saved license in ${file} is not valid: this license key failed its signature check. Copy it again from your license page.\n` +
        'Run "relay license remove", then activate your key again.\n',
    });
  });

  test("a saved key file with mode 0666 is a settings error", async () => {
    const relayHome = makeRelayHome();
    const file = saved(relayHome, KEY, 0o666);
    expect(await run(["status"], { relayHome })).toEqual({
      code: 78,
      stdout: "",
      stderr: `relay: other users can change ${file}. Run "chmod 600 ${file}" and try again.\n`,
    });
  });
});

describe("Removing a license", () => {
  test("a saved key is removed", async () => {
    const relayHome = makeRelayHome();
    const file = saved(relayHome, KEY);
    expect(await run(["remove"], { relayHome })).toEqual({ code: 0, stdout: "License removed.\n", stderr: "" });
    expect(existsSync(file)).toBe(false);
  });

  test("nothing to remove", async () => {
    expect(await run(["remove"])).toEqual({ code: 0, stdout: "No license was saved. Nothing changed.\n", stderr: "" });
  });

  test("remove works while this version cannot check keys", async () => {
    const relayHome = makeRelayHome();
    saved(relayHome, KEY);
    expect(await runRelayInProcess(["license", "remove"], { relayHome })).toEqual({ code: 0, stdout: "License removed.\n", stderr: "" });
  });
});

describe("Builds without a public key", () => {
  test.each([[["activate", "relay1.a.b"]], [["status"]]])("relay license %p exits with 69", async (args) => {
    expect(await runRelayInProcess(["license", ...args])).toEqual({
      code: 69,
      stdout: "",
      stderr: "relay: this version of relay cannot check license keys yet.\n",
    });
  });
});

describe("Public key table from the command context", () => {
  test("the environment cannot add a key to the table of the real program", async () => {
    const testPair = keyPair("test-1");
    const result = await runRelay(["license", "status"], { env: { RELAY_TEST_LICENSE_PUBLIC_KEY: testPair.x } });
    expect(result).toEqual({ code: 69, stdout: "", stderr: "relay: this version of relay cannot check license keys yet.\n" });
  });
});

describe("One list of paid features", () => {
  test("a feature added later is listed by status", async () => {
    const relayHome = makeRelayHome();
    saved(relayHome, KEY);
    const handler = licenseCommand([{ id: "failover", name: "Automatic failover" }]);
    const commands = COMMANDS.map((def) => (def.name === "license" ? { ...def, handler } : def));
    const result = await run(["status"], { relayHome, commands });
    expect(result.code).toBe(0);
    expect(result.stdout.split("\n")).toContain("Paid features: Automatic failover");
  });

  test("nothing is locked: the list is empty and only the license command checks a license", async () => {
    expect(PAID_FEATURES).toEqual([]);
    const glob = new Bun.Glob("src/**/*.ts");
    const users: string[] = [];
    for await (const file of glob.scan({ cwd: join(import.meta.dir, "..", "..") })) {
      const text = readFileSync(join(import.meta.dir, "..", "..", file), "utf8");
      if (/featureUnlocked|verifyLicenseKey|readLicense\(/.test(text) && !file.startsWith("src/license/")) users.push(file);
    }
    expect(users).toEqual(["src/cli/commands/license.ts"]);
  });
});

describe("Key not logged", () => {
  test("cli.log records license activated with the license ID, never the key", async () => {
    const relayHome = makeRelayHome();
    expect((await run(["activate", KEY], { relayHome })).code).toBe(0);
    expect((await run(["status"], { relayHome })).code).toBe(0);
    expect((await run(["remove"], { relayHome })).code).toBe(0);
    const log = readFileSync(join(relayHome, "logs", "cli.log"), "utf8");
    const entries = log.trim().split("\n").map((line) => JSON.parse(line));
    expect(entries.find((entry) => entry.msg === "license activated")).toMatchObject({ license_id: "3f9a2c1d5e7b9a01" });
    expect(entries.find((entry) => entry.msg === "license removed")).toMatchObject({ license_id: "3f9a2c1d5e7b9a01" });
    for (const part of KEY.split(".")) expect(log).not.toContain(part.slice(0, 40));
  });

  test("a failed check records only the problem", async () => {
    const relayHome = makeRelayHome();
    expect((await run(["activate", "hello-secret-looking-text"], { relayHome })).code).toBe(50);
    const log = readFileSync(join(relayHome, "logs", "cli.log"), "utf8");
    expect(log).toContain('"problem":"format"');
    expect(log).not.toContain("hello-secret-looking-text");
  });
});
