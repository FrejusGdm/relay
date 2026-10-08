// The license-checkout spec: POST /api/checkout (design decision 4).
import { describe, expect, test } from "bun:test";
import { handleCheckout } from "../src/handlers/checkout";
import { FakeStripeApi } from "./fakes/stripe";
import { deps, request, serverEnv, type Captured } from "./helpers";

describe("One-time Checkout Session", () => {
  test("the buy form creates exactly this session and redirects with 303", async () => {
    const { env } = serverEnv("test");
    const stripe = new FakeStripeApi();
    const response = await handleCheckout(request("POST", "/api/checkout"), deps(env, stripe));
    expect(stripe.created).toHaveLength(1);
    const params = stripe.created[0]!;
    const licenseId = params.metadata!.relay_license_id as string;
    expect(licenseId).toMatch(/^[0-9a-f]{16}$/);
    expect(params).toEqual({
      mode: "payment",
      line_items: [{ price: "price_A", quantity: 1 }],
      success_url: "https://relay.example/license/?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://relay.example/#buy",
      submit_type: "pay",
      metadata: { relay_product: "relay-lifetime", relay_license_id: licenseId },
      payment_intent_data: { metadata: { relay_product: "relay-lifetime", relay_license_id: licenseId } },
      integration_identifier: "relay-lifetime-checkout-qhvbtmzr",
    });
    expect(response.status).toBe(303);
    expect(response.headers.Location).toMatch(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/);
    expect(response.headers["Cache-Control"]).toBe("no-store");
  });

  test("two clicks create two sessions with two license IDs", async () => {
    const { env } = serverEnv("test");
    const stripe = new FakeStripeApi();
    await handleCheckout(request("POST", "/api/checkout"), deps(env, stripe));
    await handleCheckout(request("POST", "/api/checkout"), deps(env, stripe));
    const [first, second] = stripe.created.map((params) => params.metadata!.relay_license_id);
    expect(first).not.toBe(second);
  });
});

describe("Parameters relay never sends", () => {
  test("no payment method types, customer, tax or promotion codes, and payment mode", async () => {
    const { env } = serverEnv("test");
    const stripe = new FakeStripeApi();
    await handleCheckout(request("POST", "/api/checkout"), deps(env, stripe));
    const params = stripe.created[0]! as Record<string, unknown>;
    for (const key of ["payment_method_types", "customer", "customer_creation", "automatic_tax", "allow_promotion_codes"]) {
      expect(Object.hasOwn(params, key)).toBe(false);
    }
    expect(params.mode).toBe("payment");
  });
});

describe("Errors and other methods", () => {
  test("GET gets 405", async () => {
    const stripe = new FakeStripeApi();
    const response = await handleCheckout(request("GET", "/api/checkout"), deps(serverEnv("test").env, stripe));
    expect(response.status).toBe(405);
    expect(stripe.calls).toBe(0);
  });

  test("a Stripe connection error gets 502 with the page text and no secret", async () => {
    const { env } = serverEnv("test");
    const stripe = new FakeStripeApi();
    stripe.failure = "network";
    const logs: Captured[] = [];
    const response = await handleCheckout(request("POST", "/api/checkout"), deps(env, stripe, logs));
    expect(response.status).toBe(502);
    expect(response.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(response.body).toContain("Payment could not start. Nothing was charged. Try again in a minute.");
    expect(response.body).toContain('href="/#buy"');
    const text = response.body + JSON.stringify(logs);
    for (const value of Object.values(env)) expect(text).not.toContain(value);
  });
});
