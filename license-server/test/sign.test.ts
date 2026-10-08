// The license-keys spec, "Key format" and "Deterministic signing", on the server side.
import { expect, test } from "bun:test";
import { signLicenseKey } from "../src/core/sign";
import { signingKey } from "./helpers";

const input = () => ({ kid: "live-1", privateKey: signingKey().privateKey, licenseId: "3f9a2c1d5e7b9a01", issued: "2026-10-07" });

test("the decoded payload is exactly the JSON of the design", () => {
  const key = signLicenseKey(input());
  expect(Buffer.from(key.split(".")[1]!, "base64url").toString("utf8")).toBe(
    '{"v":1,"kid":"live-1","product":"relay-lifetime","license":"3f9a2c1d5e7b9a01","issued":"2026-10-07"}',
  );
  expect(key.startsWith("relay1.")).toBe(true);
});

test("two signatures of the same input are identical", () => {
  const same = input();
  expect(signLicenseKey(same)).toBe(signLicenseKey({ ...same }));
});

test("the signature part has 86 characters", () => {
  const parts = signLicenseKey(input()).split(".");
  expect(parts).toHaveLength(3);
  expect(parts[2]).toMatch(/^[A-Za-z0-9_-]{86}$/);
});
