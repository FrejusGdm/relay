// The license-keys spec, "Signer and checker agree": the license server's signLicenseKey and
// relay's verifyLicenseKey, with key pairs made while the test runs.
import { expect, test } from "bun:test";
import { signLicenseKey } from "../../license-server/src/core/sign";
import { verifyLicenseKey } from "../../src/license/key";
import { keyPair, table } from "./keys";

test("a key signed by the server checks as valid in relay", () => {
  const pair = keyPair("live-1");
  const key = signLicenseKey({ kid: "live-1", privateKey: pair.privateKey, licenseId: "0123456789abcdef", issued: "2026-12-31" });
  expect(verifyLicenseKey(key, table(pair))).toEqual({
    ok: true,
    license: { licenseId: "0123456789abcdef", issued: "2026-12-31", kid: "live-1" },
  });
});

test("signing the same input twice gives the same key", () => {
  const pair = keyPair("live-1");
  const input = { kid: "live-1", privateKey: pair.privateKey, licenseId: "0123456789abcdef", issued: "2026-12-31" };
  expect(signLicenseKey(input)).toBe(signLicenseKey(input));
});
