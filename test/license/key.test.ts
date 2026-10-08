// The license-keys spec: "Key format", "Offline check" and "Test keys never unlock relay".
import { describe, expect, test } from "bun:test";
import { verifyLicenseKey } from "../../src/license/key";
import { LICENSE_PUBLIC_KEYS } from "../../src/license/public-keys";
import { decodePayload, keyPair, keyWithPayload, licenseKey, table } from "./keys";

const live = keyPair("live-1");
const keys = table(live);
const PAYLOAD = '{"v":1,"kid":"live-1","product":"relay-lifetime","license":"3f9a2c1d5e7b9a01","issued":"2026-10-07"}';

describe("Key format", () => {
  test("the payload of a live key is the exact JSON, and the signature part has 86 characters", () => {
    const key = licenseKey(live);
    expect(decodePayload(key)).toBe(PAYLOAD);
    expect(key.startsWith("relay1.")).toBe(true);
    expect(key.split(".")[2]!.length).toBe(86);
  });

  test("the payload holds no personal data, only the five fields", () => {
    const fields = Object.keys(JSON.parse(decodePayload(licenseKey(live))));
    expect(fields).toEqual(["v", "kid", "product", "license", "issued"]);
    expect(decodePayload(licenseKey(live))).not.toMatch(/@|email|name/i);
  });
});

describe("Offline check", () => {
  test("a valid key gives the license ID, issue date and key ID", () => {
    expect(verifyLicenseKey(licenseKey(live), keys)).toEqual({
      ok: true,
      license: { licenseId: "3f9a2c1d5e7b9a01", issued: "2026-10-07", kid: "live-1" },
    });
  });

  test("a valid key with a line break and spaces inside it is still valid", () => {
    const key = licenseKey(live);
    const wrapped = `  ${key.slice(0, 60)}\n  ${key.slice(60, 120)} \r\n${key.slice(120)}\n`;
    expect(verifyLicenseKey(wrapped, keys)).toMatchObject({ ok: true, license: { licenseId: "3f9a2c1d5e7b9a01" } });
  });

  test("a payload changed by one character that still decodes to valid JSON fails the signature check", () => {
    const [prefix, payload, signature] = licenseKey(live).split(".") as [string, string, string];
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let changed: string | null = null;
    for (let i = 0; i < payload.length && changed === null; i++) {
      for (const char of alphabet) {
        if (char === payload[i]) continue;
        const candidate = `${prefix}.${payload.slice(0, i)}${char}${payload.slice(i + 1)}.${signature}`;
        // The first change whose payload still passes the format checks and keeps the key ID.
        const result = verifyLicenseKey(candidate, keys);
        if ((result.ok || result.problem !== "format") && JSON.parse(decodePayload(candidate)).kid === "live-1") {
          changed = candidate;
          break;
        }
      }
    }
    expect(changed).not.toBeNull();
    expect(() => JSON.parse(decodePayload(changed!))).not.toThrow();
    expect(verifyLicenseKey(changed!, keys)).toEqual({ ok: false, problem: "signature" });
  });

  test.each([
    ["hello", "hello"],
    ["text longer than 1,024 characters", `relay1.${"A".repeat(1100)}`],
    ["a key without its signature", licenseKey(live).split(".").slice(0, 2).join(".")],
  ])("%s is not a key", (_, text) => {
    expect(verifyLicenseKey(text, keys)).toEqual({ ok: false, problem: "format" });
  });

  test.each([
    ["version 2", { v: 2, kid: "live-1", product: "relay-lifetime", license: "3f9a2c1d5e7b9a01", issued: "2026-10-07" }],
    ["a key ID of another form", { v: 1, kid: "prod-1", product: "relay-lifetime", license: "3f9a2c1d5e7b9a01", issued: "2026-10-07" }],
    ["an upper-case license ID", { v: 1, kid: "live-1", product: "relay-lifetime", license: "3F9A2C1D5E7B9A01", issued: "2026-10-07" }],
    ["a date that does not exist", { v: 1, kid: "live-1", product: "relay-lifetime", license: "3f9a2c1d5e7b9a01", issued: "2026-02-30" }],
    ["a product that is not text", { v: 1, kid: "live-1", product: 7, license: "3f9a2c1d5e7b9a01", issued: "2026-10-07" }],
    ["a list instead of an object", [1, 2]],
  ])("a signed payload with %s is a format problem", (_, payload) => {
    expect(verifyLicenseKey(keyWithPayload(live, payload), keys)).toEqual({ ok: false, problem: "format" });
  });

  test("unknown extra fields are ignored", () => {
    const payload = JSON.parse(PAYLOAD);
    expect(verifyLicenseKey(keyWithPayload(live, { ...payload, note: "x" }), keys).ok).toBe(true);
  });

  test("a key signed with a key ID the table does not hold is unknown_key", () => {
    expect(verifyLicenseKey(licenseKey(keyPair("live-9")), keys)).toEqual({ ok: false, problem: "unknown_key" });
  });

  test("a key signed by another private key under a known key ID fails the signature check", () => {
    expect(verifyLicenseKey(licenseKey(keyPair("live-1")), keys)).toEqual({ ok: false, problem: "signature" });
  });

  test("a correctly signed key for relay-cloud is another product", () => {
    const payload = { ...JSON.parse(PAYLOAD), product: "relay-cloud" };
    expect(verifyLicenseKey(keyWithPayload(live, payload), keys)).toEqual({ ok: false, problem: "product" });
  });

  test("the problems are reported in the order format, key ID, signature, product", () => {
    const other = keyPair("live-1");
    const payload = { ...JSON.parse(PAYLOAD), product: "relay-cloud" };
    expect(verifyLicenseKey(keyWithPayload(other, payload), keys)).toEqual({ ok: false, problem: "signature" });
    expect(verifyLicenseKey(keyWithPayload(other, { ...payload, kid: "live-2" }), keys)).toEqual({ ok: false, problem: "unknown_key" });
  });
});

describe("Test keys never unlock relay", () => {
  const testPair = keyPair("test-1");

  test("a key signed with test-1 is test_key, even when the table holds test-1", () => {
    expect(verifyLicenseKey(licenseKey(testPair), table(testPair))).toEqual({ ok: false, problem: "test_key" });
  });

  test("only allowTestKeys lets a test key through", () => {
    expect(verifyLicenseKey(licenseKey(testPair), table(testPair), { allowTestKeys: true })).toMatchObject({ ok: true });
  });

  test("the built-in table holds only live- key IDs", () => {
    for (const kid of Object.keys(LICENSE_PUBLIC_KEYS)) expect(kid.startsWith("live-")).toBe(true);
  });
});
