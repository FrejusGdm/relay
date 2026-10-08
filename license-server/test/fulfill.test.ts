// The license-fulfillment spec, "Fulfillment rules" and "Safe to repeat" (design decision 6).
import { describe, expect, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import { fulfillCheckout, type FulfillResult } from "../src/core/fulfill";
import { loadSettings, type Settings } from "../src/core/settings";
import { BUYER_EMAIL, CREATED, FakeStripeApi } from "./fakes/stripe";
import { serverEnv, signingKey } from "./helpers";

function settingsFor(mode: "test" | "live", overrides: Record<string, string> = {}): Settings {
  const result = loadSettings(serverEnv(mode, overrides).env);
  if (!result.ok) throw new Error(`test settings not valid: ${result.problems.join(", ")}`);
  return result.settings;
}

function payloadOf(result: FulfillResult): Record<string, unknown> {
  if (result.state !== "issued") throw new Error(`expected issued, got ${result.state}`);
  return JSON.parse(Buffer.from(result.key.split(".")[1]!, "base64url").toString("utf8"));
}

describe("Fulfillment rules", () => {
  test("a complete, paid session is issued a key for its license ID and creation date", async () => {
    const settings = settingsFor("test");
    const stripe = new FakeStripeApi();
    const id = stripe.addSession();
    const licenseId = stripe.sessions.get(id)!.metadata!.relay_license_id;
    const result = await fulfillCheckout(id, { settings, stripe });
    expect(result).toMatchObject({ state: "issued", licenseId, issued: "2026-10-07" });
    expect(payloadOf(result)).toEqual({ v: 1, kid: "test-1", product: "relay-lifetime", license: licenseId, issued: "2026-10-07" });
    // The signature checks with the public key of the signing key.
    const [prefix, payload, signature] = (result as { key: string }).key.split(".");
    const publicKey = createPublicKey(settings.signingKey);
    expect(verify(null, Buffer.from(`${prefix}.${payload}`), publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
  });

  test("the issue date is the UTC date of the session's creation time", async () => {
    const settings = settingsFor("test");
    const stripe = new FakeStripeApi();
    const id = stripe.addSession({ created: Date.UTC(2026, 11, 31, 23, 59, 59) / 1000 });
    expect(await fulfillCheckout(id, { settings, stripe })).toMatchObject({ issued: "2026-12-31" });
  });

  test("the key holds no email address", async () => {
    const settings = settingsFor("test");
    const stripe = new FakeStripeApi();
    const result = await fulfillCheckout(stripe.addSession(), { settings, stripe });
    expect(JSON.stringify(payloadOf(result))).not.toContain(BUYER_EMAIL);
    expect((result as { key: string }).key).not.toContain(Buffer.from(BUYER_EMAIL).toString("base64url"));
  });

  test.each([
    ["another mode", { checkoutMode: "subscription" as const }, "mode"],
    ["live data in test mode", { livemode: true }, "livemode"],
    ["no relay_product metadata", { metadata: { relay_license_id: "3f9a2c1d5e7b9a01" } }, "product"],
    ["a license ID of another form", { metadata: { relay_product: "relay-lifetime", relay_license_id: "XYZ" } }, "license_id"],
    ["a price not in RELAY_LICENSE_PRICE_IDS", { priceId: "price_Other" }, "line_items"],
    ["two line items", { lineItems: 2 }, "line_items"],
    ["a quantity of 2", { quantity: 2 }, "line_items"],
  ] as const)("%s is rejected and issues no key", async (_, options, reason) => {
    const settings = settingsFor("test");
    const stripe = new FakeStripeApi();
    expect(await fulfillCheckout(stripe.addSession(options), { settings, stripe })).toEqual({ state: "rejected", reason });
    expect(stripe.updates).toEqual([]);
  });

  test("a session bought at an earlier price is still issued", async () => {
    const settings = settingsFor("test", { RELAY_STRIPE_PRICE_ID: "price_B", RELAY_LICENSE_PRICE_IDS: "price_A,price_B" });
    const stripe = new FakeStripeApi();
    expect(await fulfillCheckout(stripe.addSession({ priceId: "price_A" }), { settings, stripe })).toMatchObject({ state: "issued" });
  });

  test("an unpaid, complete session is pending", async () => {
    const settings = settingsFor("test");
    const stripe = new FakeStripeApi();
    const id = stripe.addSession({ paymentStatus: "unpaid" });
    expect(await fulfillCheckout(id, { settings, stripe })).toEqual({ state: "pending" });
    expect(stripe.updates).toEqual([]);
  });

  test.each(["expired", "open"] as const)("an %s session is not found", async (status) => {
    const settings = settingsFor("test");
    const stripe = new FakeStripeApi();
    expect(await fulfillCheckout(stripe.addSession({ status, paymentStatus: "unpaid" }), { settings, stripe })).toEqual({ state: "not_found" });
  });

  test("a session Stripe does not have is not found", async () => {
    const settings = settingsFor("test");
    const stripe = new FakeStripeApi();
    expect(await fulfillCheckout("cs_test_a1b2c3d4e5f6a7b8c9d0", { settings, stripe })).toEqual({ state: "not_found" });
    expect(stripe.calls).toBe(1);
  });

  test.each(["cs_live_a1b2c3d4e5f6a7b8c9d0", "pi_test_a1b2c3d4e5f6a7b8c9d0", "cs_test_x", "cs_test_a1b2c3d4e5/../x", ""])(
    "the malformed session ID %p is not found, without a Stripe call",
    async (id) => {
      const settings = settingsFor("test");
      const stripe = new FakeStripeApi();
      expect(await fulfillCheckout(id, { settings, stripe })).toEqual({ state: "not_found" });
      expect(stripe.calls).toBe(0);
    },
  );

  test("a no_payment_required session without a PaymentIntent is issued with no metadata update", async () => {
    const settings = settingsFor("test");
    const stripe = new FakeStripeApi();
    const id = stripe.addSession({ paymentStatus: "no_payment_required", withPaymentIntent: false });
    expect(await fulfillCheckout(id, { settings, stripe })).toMatchObject({ state: "issued" });
    expect(stripe.updates).toEqual([]);
  });

  test("a network error is thrown, so the caller can answer 500 or 503", async () => {
    const settings = settingsFor("test");
    const stripe = new FakeStripeApi();
    const id = stripe.addSession();
    stripe.failure = "network";
    await expect(fulfillCheckout(id, { settings, stripe })).rejects.toThrow("connection to Stripe");
  });
});

describe("Safe to repeat", () => {
  test("three deliveries and one license page request give the same key and the same record", async () => {
    const settings = settingsFor("live");
    const stripe = new FakeStripeApi();
    const id = stripe.addSession({ mode: "live" });
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await fulfillCheckout(id, { settings, stripe }));
    const keys = new Set(results.map((result) => (result as { key: string }).key));
    expect(keys.size).toBe(1);
    expect(stripe.updates).toEqual([
      {
        paymentIntentId: stripe.intentOf(id)!.id,
        metadata: { relay_license_issued: "2026-10-07", relay_license_key_id: "live-1" },
        idempotencyKey: `relay-license-${id}-live-1`,
      },
    ]);
    expect(stripe.intentOf(id)!.metadata).toMatchObject({ relay_license_issued: "2026-10-07", relay_license_key_id: "live-1" });
  });

  test("ten concurrent calls return the same key, and every update has the same values and idempotency key", async () => {
    const settings = settingsFor("live");
    const stripe = new FakeStripeApi();
    const id = stripe.addSession({ mode: "live" });
    const results = await Promise.all(Array.from({ length: 10 }, () => fulfillCheckout(id, { settings, stripe })));
    expect(new Set(results.map((result) => (result as { key: string }).key)).size).toBe(1);
    expect(stripe.updates.length).toBeGreaterThan(0);
    for (const update of stripe.updates) {
      expect(update.metadata).toEqual({ relay_license_issued: "2026-10-07", relay_license_key_id: "live-1" });
      expect(update.idempotencyKey).toBe(`relay-license-${id}-live-1`);
    }
  });

  test("after a signing key rotation from live-1 to live-2, the key is signed with live-2 and the record moves", async () => {
    const stripe = new FakeStripeApi();
    const id = stripe.addSession({ mode: "live", created: CREATED });
    stripe.intentOf(id)!.metadata = { ...stripe.intentOf(id)!.metadata, relay_license_issued: "2026-10-07", relay_license_key_id: "live-1" };
    const settings = settingsFor("live", { RELAY_LICENSE_KEY_ID: "live-2", RELAY_LICENSE_SIGNING_KEY: signingKey().der });
    const result = await fulfillCheckout(id, { settings, stripe });
    expect(payloadOf(result).kid).toBe("live-2");
    expect(stripe.updates).toEqual([
      {
        paymentIntentId: stripe.intentOf(id)!.id,
        metadata: { relay_license_issued: "2026-10-07", relay_license_key_id: "live-2" },
        idempotencyKey: `relay-license-${id}-live-2`,
      },
    ]);
  });
});
