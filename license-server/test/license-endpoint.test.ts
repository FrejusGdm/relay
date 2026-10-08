// The license-fulfillment spec, "License endpoint": GET /api/license (design decision 7).
import { describe, expect, test } from "bun:test";
import { handleLicense } from "../src/handlers/license";
import { FakeStripeApi } from "./fakes/stripe";
import { deps, request, serverEnv } from "./helpers";

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };

async function ask(stripe: FakeStripeApi, sessionId: string, env: Record<string, string> = serverEnv("test").env, method = "GET") {
  const response = await handleLicense(request(method, `/api/license?session_id=${encodeURIComponent(sessionId)}`), deps(env, stripe));
  return { ...response, json: JSON.parse(response.body) };
}

describe("License endpoint", () => {
  test("a paid session gets 200 with the key and the three headers", async () => {
    const stripe = new FakeStripeApi();
    const id = stripe.addSession();
    const response = await ask(stripe, id);
    expect(response.status).toBe(200);
    expect(response.headers).toMatchObject({ "Content-Type": "application/json", ...HEADERS });
    expect(response.json).toEqual({
      state: "issued",
      key: expect.stringMatching(/^relay1\./),
      license: stripe.sessions.get(id)!.metadata!.relay_license_id,
      issued: "2026-10-07",
    });
  });

  test("a pending payment gets 202", async () => {
    const stripe = new FakeStripeApi();
    const response = await ask(stripe, stripe.addSession({ paymentStatus: "unpaid" }));
    expect([response.status, response.json]).toEqual([202, { state: "pending" }]);
    expect(response.headers).toMatchObject(HEADERS);
  });

  test("a rejected session looks the same as a missing one", async () => {
    const stripe = new FakeStripeApi();
    const rejected = await ask(stripe, stripe.addSession({ metadata: { relay_product: "other", relay_license_id: "3f9a2c1d5e7b9a01" } }));
    const missing = await ask(stripe, "cs_test_a1b2c3d4e5f6a7b8c9d0");
    for (const response of [rejected, missing]) {
      expect([response.status, response.json]).toEqual([404, { state: "not_found" }]);
      expect(response.headers).toMatchObject(HEADERS);
    }
  });

  test("a request without session_id is not found, without a Stripe call", async () => {
    const stripe = new FakeStripeApi();
    const response = await handleLicense(request("GET", "/api/license"), deps(serverEnv("test").env, stripe));
    expect([response.status, JSON.parse(response.body)]).toEqual([404, { state: "not_found" }]);
    expect(stripe.calls).toBe(0);
  });

  test("a Stripe error gets 503 with the error state", async () => {
    const stripe = new FakeStripeApi();
    const id = stripe.addSession();
    stripe.failure = "network";
    const response = await ask(stripe, id);
    expect([response.status, response.json]).toEqual([503, { state: "error" }]);
    expect(response.headers).toMatchObject(HEADERS);
  });

  test("wrong settings get 503 not_configured", async () => {
    const stripe = new FakeStripeApi();
    const response = await ask(stripe, "cs_test_a1b2c3d4e5f6a7b8c9d0", {});
    expect([response.status, response.json]).toEqual([503, { error: "not_configured" }]);
    expect(response.headers).toMatchObject(HEADERS);
  });

  test("another method gets 405", async () => {
    const response = await ask(new FakeStripeApi(), "cs_test_a1b2c3d4e5f6a7b8c9d0", serverEnv("test").env, "POST");
    expect([response.status, response.json]).toEqual([405, { error: "method_not_allowed" }]);
  });
});
