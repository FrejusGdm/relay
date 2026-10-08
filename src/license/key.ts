// Checks a relay license key on this computer, without any network access (add-lifetime-license,
// design decisions 8 and 9). A key is relay1.<payload>.<signature>: the payload is base64url JSON,
// and the signature is Ed25519 over the ASCII bytes "relay1.<payload>".
import { createPublicKey, verify } from "node:crypto";
import { LICENSE_PUBLIC_KEYS } from "./public-keys";

export type KeyProblem = "format" | "test_key" | "unknown_key" | "signature" | "product";

export interface License {
  licenseId: string;
  issued: string;
  kid: string;
}

const MAX_LENGTH = 1024;
const SHAPE = /^relay1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{86})$/;

export function verifyLicenseKey(
  text: string,
  publicKeys: Readonly<Record<string, string>> = LICENSE_PUBLIC_KEYS,
  options: { allowTestKeys?: boolean } = {},
): { ok: true; license: License } | { ok: false; problem: KeyProblem } {
  // Mail programs and terminals sometimes wrap long lines.
  const key = text.replace(/\s/g, "");
  if (key.length > MAX_LENGTH) return { ok: false, problem: "format" };
  const match = SHAPE.exec(key);
  if (match === null) return { ok: false, problem: "format" };
  const payload = match[1]!;
  const signature = match[2]!;
  const fields = readPayload(payload);
  if (fields === null) return { ok: false, problem: "format" };

  if (fields.kid.startsWith("test-") && options.allowTestKeys !== true) return { ok: false, problem: "test_key" };
  if (!Object.hasOwn(publicKeys, fields.kid)) return { ok: false, problem: "unknown_key" };
  if (!signatureMatches(payload, signature, publicKeys[fields.kid]!)) return { ok: false, problem: "signature" };
  if (fields.product !== "relay-lifetime") return { ok: false, problem: "product" };
  return { ok: true, license: { licenseId: fields.license, issued: fields.issued, kid: fields.kid } };
}

interface Payload {
  kid: string;
  product: string;
  license: string;
  issued: string;
}

// The decoded payload when it has every field in the right form; unknown extra fields are ignored.
function readPayload(payload: string): Payload | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  if (fields.v !== 1) return null;
  const { kid, product, license, issued } = fields;
  if (typeof kid !== "string" || !/^(test|live)-[0-9]+$/.test(kid)) return null;
  if (typeof product !== "string") return null;
  if (typeof license !== "string" || !/^[0-9a-f]{16}$/.test(license)) return null;
  if (typeof issued !== "string" || !isRealDate(issued)) return null;
  return { kid, product, license, issued };
}

function isRealDate(text: string): boolean {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function signatureMatches(payload: string, signature: string, x: string): boolean {
  try {
    const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
    return verify(null, Buffer.from(`relay1.${payload}`, "ascii"), publicKey, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}
