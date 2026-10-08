// The license-fulfillment spec, "Server settings", and the rules of design decision 2. Every fake
// value is built while the test runs.
import { describe, expect, test } from "bun:test";
import { handleCheckout } from "../src/handlers/checkout";
import { handleLicense } from "../src/handlers/license";
import { handleWebhook } from "../src/handlers/webhook";
import { loadSettings } from "../src/core/settings";
import { FakeStripeApi } from "./fakes/stripe";
import { deps, request, serverEnv, type Captured } from "./helpers";

const problems = (env: Record<string, string | undefined>) => {
  const result = loadSettings(env);
  return result.ok ? [] : result.problems;
};

describe("valid settings", () => {
  test("test mode", () => {
    const { env } = serverEnv("test");
    const result = loadSettings(env);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.settings.mode).toBe("test");
      expect(result.settings.kid).toBe("test-1");
      expect(result.settings.licensePriceIds).toEqual(["price_A"]);
    }
  });

  test("live mode, and http://localhost only in test mode", () => {
    expect(loadSettings(serverEnv("live").env).ok).toBe(true);
    expect(loadSettings(serverEnv("test", { RELAY_SITE_URL: "http://localhost:7101" }).env).ok).toBe(true);
    expect(problems(serverEnv("live", { RELAY_SITE_URL: "http://localhost:7101" }).env)).toEqual(["RELAY_SITE_URL"]);
  });

  test("several price IDs, with spaces after the commas", () => {
    const result = loadSettings(serverEnv("test", { RELAY_STRIPE_PRICE_ID: "price_B", RELAY_LICENSE_PRICE_IDS: "price_A, price_B" }).env);
    expect(result.ok && result.settings.licensePriceIds).toEqual(["price_A", "price_B"]);
  });
});

describe("wrong settings are named, never shown", () => {
  test.each([
    ["a missing setting", { RELAY_SITE_URL: undefined }, ["RELAY_SITE_URL"]],
    ["a secret key", { STRIPE_API_KEY: "sk_" + "test_" + "fake" }, ["STRIPE_API_KEY"]],
    ["mixed modes", { STRIPE_API_KEY: "rk_" + "live_" + "fake" }, ["RELAY_LICENSE_KEY_ID"]],
    ["an http:// site address in live mode", { STRIPE_API_KEY: "rk_" + "live_" + "fake", RELAY_LICENSE_KEY_ID: "live-1", RELAY_SITE_URL: "http://relay.example" }, ["RELAY_SITE_URL"]],
    ["a site address with a final /", { RELAY_SITE_URL: "https://relay.example/" }, ["RELAY_SITE_URL"]],
    ["a key ID of another form", { RELAY_LICENSE_KEY_ID: "prod-1" }, ["RELAY_LICENSE_KEY_ID"]],
    ["a webhook secret of another form", { STRIPE_WEBHOOK_SECRET: "secret" }, ["STRIPE_WEBHOOK_SECRET"]],
    ["a price ID without price_", { RELAY_STRIPE_PRICE_ID: "prod_A", RELAY_LICENSE_PRICE_IDS: "prod_A" }, ["RELAY_STRIPE_PRICE_ID", "RELAY_LICENSE_PRICE_IDS"]],
    ["a price list entry without price_", { RELAY_LICENSE_PRICE_IDS: "price_A,prod_B" }, ["RELAY_LICENSE_PRICE_IDS"]],
    ["the current price missing from the list", { RELAY_STRIPE_PRICE_ID: "price_B", RELAY_LICENSE_PRICE_IDS: "price_A" }, ["RELAY_LICENSE_PRICE_IDS"]],
    ["a signing key that is not base64 DER", { RELAY_LICENSE_SIGNING_KEY: "not a key" }, ["RELAY_LICENSE_SIGNING_KEY"]],
  ] as const)("%s", (_, overrides, expected) => {
    const { env } = serverEnv("test");
    expect(problems({ ...env, ...overrides })).toEqual([...expected]);
  });

  test("a signing key that is not Ed25519", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    expect(problems(serverEnv("test", { RELAY_LICENSE_SIGNING_KEY: ec }).env)).toEqual(["RELAY_LICENSE_SIGNING_KEY"]);
  });

  test("no settings at all names all seven", () => {
    expect(problems({})).toHaveLength(7);
  });
});

describe("every function answers 503 and logs only the names", () => {
  const cases = [
    ["a secret key", { STRIPE_API_KEY: "sk_" + "test_" + "fake" + crypto.randomUUID() }, "STRIPE_API_KEY"],
    ["mixed modes", { STRIPE_API_KEY: "rk_" + "live_" + "fake" + crypto.randomUUID() }, "RELAY_LICENSE_KEY_ID"],
    ["the current price missing from the list", { RELAY_STRIPE_PRICE_ID: "price_B", RELAY_LICENSE_PRICE_IDS: "price_A" }, "RELAY_LICENSE_PRICE_IDS"],
  ] as const;

  test.each(cases)("%s", async (_, overrides, name) => {
    const { env } = serverEnv("test", { ...overrides });
    const stripe = new FakeStripeApi();
    const logs: Captured[] = [];
    const responses = [
      await handleCheckout(request("POST", "/api/checkout"), deps(env, stripe, logs)),
      await handleWebhook(request("POST", "/api/stripe-webhook", "{}"), deps(env, stripe, logs)),
      await handleLicense(request("GET", "/api/license?session_id=cs_test_aaaaaaaaaaaa"), deps(env, stripe, logs)),
    ];
    for (const response of responses) {
      expect(response.status).toBe(503);
      expect(JSON.parse(response.body)).toEqual({ error: "not_configured" });
    }
    expect(stripe.calls).toBe(0);
    expect(logs).toHaveLength(3);
    for (const entry of logs) {
      expect(entry.message).toBe("settings invalid");
      expect(entry.fields.settings).toContain(name);
    }
    const text = JSON.stringify(logs) + responses.map((response) => response.body).join("");
    for (const value of Object.values(env)) expect(text).not.toContain(value);
  });
});
