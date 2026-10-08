// Key pairs and license keys made while the tests run. No key is ever committed.
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { signLicenseKey } from "../../license-server/src/core/sign";

export interface TestKeyPair {
  kid: string;
  privateKey: KeyObject;
  x: string;   // the public key, as LICENSE_PUBLIC_KEYS holds it
}

export function keyPair(kid: string): TestKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { kid, privateKey, x: publicKey.export({ format: "jwk" }).x! };
}

export function table(...pairs: TestKeyPair[]): Record<string, string> {
  return Object.fromEntries(pairs.map((pair) => [pair.kid, pair.x]));
}

export function licenseKey(pair: TestKeyPair, licenseId = "3f9a2c1d5e7b9a01", issued = "2026-10-07"): string {
  return signLicenseKey({ kid: pair.kid, privateKey: pair.privateKey, licenseId, issued });
}

// A correctly signed key with any payload, for the cases the server never signs.
export function keyWithPayload(pair: TestKeyPair, payload: unknown): string {
  const signed = `relay1.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
  return `${signed}.${sign(null, Buffer.from(signed, "ascii"), pair.privateKey).toString("base64url")}`;
}

export function decodePayload(key: string): string {
  return Buffer.from(key.split(".")[1]!, "base64url").toString("utf8");
}
