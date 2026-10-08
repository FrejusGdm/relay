// scripts/verify-key.ts: checks a key with relay's own checker against one public key.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { signLicenseKey } from "../src/core/sign";
import { signingKey } from "./helpers";

const script = join(import.meta.dir, "..", "scripts", "verify-key.ts");

function verifyKey(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, script, ...args], { env: { PATH: process.env.PATH ?? "" } });
  return { code: result.exitCode, stdout: result.stdout.toString() };
}

test("a test-mode key signed with the given public key is valid", () => {
  const key = signingKey();
  const text = signLicenseKey({ kid: "test-1", privateKey: key.privateKey, licenseId: "3f9a2c1d5e7b9a01", issued: "2026-10-07" });
  expect(verifyKey(text, "--public-key", key.x, "--kid", "test-1")).toEqual({
    code: 0,
    stdout: "valid: license 3f9a2c1d5e7b9a01, issued 2026-10-07\n",
  });
});

test("a key signed with another private key is not valid", () => {
  const text = signLicenseKey({ kid: "test-1", privateKey: signingKey().privateKey, licenseId: "3f9a2c1d5e7b9a01", issued: "2026-10-07" });
  expect(verifyKey(text, "--public-key", signingKey().x, "--kid", "test-1")).toEqual({ code: 1, stdout: "not valid: signature\n" });
});
