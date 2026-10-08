// Settings, keys and captured logs for the license server tests. Every fake secret is built while
// the tests run; nothing that looks like a key is committed.
import { generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import type { Deps, LogValue } from "../src/core/http";
import { loadSettings, type SETTING_NAMES } from "../src/core/settings";
import type { StripeApi } from "../src/core/stripe-client";

export interface TestServer {
  env: Record<(typeof SETTING_NAMES)[number], string> & Record<string, string>;
  publicX: string;
  privateKey: KeyObject;
}

const random = () => randomBytes(12).toString("hex");

export function signingKey(): { der: string; x: string; privateKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    der: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    x: publicKey.export({ format: "jwk" }).x!,
    privateKey,
  };
}

// Test mode with key ID test-1 unless the mode is "live" (key ID live-1).
export function serverEnv(mode: "test" | "live" = "test", overrides: Record<string, string> = {}): TestServer {
  const key = signingKey();
  const env = {
    STRIPE_API_KEY: `rk_${mode}_` + "fake" + random(),
    STRIPE_WEBHOOK_SECRET: "whsec_" + "test" + random(),
    RELAY_STRIPE_PRICE_ID: "price_A",
    RELAY_LICENSE_PRICE_IDS: "price_A",
    RELAY_LICENSE_SIGNING_KEY: key.der,
    RELAY_LICENSE_KEY_ID: `${mode}-1`,
    RELAY_SITE_URL: "https://relay.example",
    ...overrides,
  };
  return { env, publicX: key.x, privateKey: key.privateKey };
}

export interface Captured {
  level: string;
  message: string;
  fields: Record<string, LogValue>;
}

export function deps(env: Record<string, string | undefined>, stripe: StripeApi, logs: Captured[] = []): Deps {
  return {
    settings: loadSettings(env),
    stripe: () => stripe,
    log: (level, message, fields = {}) => logs.push({ level, message, fields }),
  };
}

export function request(method: string, url: string, body: string | Uint8Array = "", headers: Record<string, string> = {}) {
  return {
    method,
    url: `https://relay.example${url}`,
    headers: new Headers(headers),
    body: typeof body === "string" ? new TextEncoder().encode(body) : body,
  };
}
