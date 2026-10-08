// Signs a relay license key (add-lifetime-license, design decision 8). This file imports only
// node:crypto, so the relay project's tests can import it to prove that the signer and the checker
// in src/license/key.ts agree.
import { sign, type KeyObject } from "node:crypto";

export interface LicenseKeyInput {
  kid: string;
  privateKey: KeyObject;
  licenseId: string;
  issued: string;
}

// The payload keys are written in this order and without spaces. Ed25519 signatures are
// deterministic, so the same input always gives the same key.
export function signLicenseKey({ kid, privateKey, licenseId, issued }: LicenseKeyInput): string {
  const json = JSON.stringify({ v: 1, kid, product: "relay-lifetime", license: licenseId, issued });
  const signed = `relay1.${Buffer.from(json, "utf8").toString("base64url")}`;
  const signature = sign(null, Buffer.from(signed, "ascii"), privateKey);
  return `${signed}.${signature.toString("base64url")}`;
}
