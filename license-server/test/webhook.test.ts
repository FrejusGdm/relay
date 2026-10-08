// The license-fulfillment spec: "Webhook signature check", "Events handled" and "Nothing secret
// leaves the server" (design decision 5). Bodies are thin event notifications signed with the
// Stripe library's generateTestHeaderStringAsync and a secret made while the test runs.
import { describe, expect, test } from "bun:test";
import { handleCheckout } from "../src/handlers/checkout";
import { handleLicense } from "../src/handlers/license";
import { handleWebhook } from "../src/handlers/webhook";
import { BUYER_EMAIL, FakeStripeApi, signedHeader, thinEvent } from "./fakes/stripe";
import { deps, request, serverEnv, type Captured } from "./helpers";

const COMPLETED = "v1.checkout.session.completed";

function setup(mode: "test" | "live" = "test") {
  const { env } = serverEnv(mode);
  const stripe = new FakeStripeApi(env.STRIPE_WEBHOOK_SECRET);
  const logs: Captured[] = [];
  const deliver = (body: string | Uint8Array, header?: string) =>
    handleWebhook(
      request("POST", "/api/stripe-webhook", body, header === undefined ? {} : { "Stripe-Signature": header }),
      deps(env, stripe, logs),
    );
  const signed = async (body: string, timestamp?: number) => deliver(body, await signedHeader(body, env.STRIPE_WEBHOOK_SECRET, timestamp));
  return { env, stripe, logs, deliver, signed };
}

describe("Webhook signature check", () => {
  test("a valid completed event for a paid session runs fulfillment and answers 200", async () => {
    const { stripe, signed, logs } = setup();
    const id = stripe.addSession();
    const response = await signed(thinEvent(COMPLETED, id));
    expect([response.status, JSON.parse(response.body)]).toEqual([200, { received: true }]);
    expect(stripe.calls).toBe(2);
    expect(stripe.updates).toHaveLength(1);
    expect(logs.at(-1)).toMatchObject({
      message: "webhook handled",
      fields: { event_type: COMPLETED, session_id: id, outcome: "issued", license_id: stripe.sessions.get(id)!.metadata!.relay_license_id },
    });
  });

  test("a body signed with another secret is refused before any Stripe call", async () => {
    const { stripe, deliver } = setup();
    const body = thinEvent(COMPLETED, stripe.addSession());
    const response = await deliver(body, await signedHeader(body, "whsec_" + "other" + crypto.randomUUID()));
    expect([response.status, JSON.parse(response.body)]).toEqual([400, { error: "invalid_signature" }]);
    expect(stripe.calls).toBe(0);
  });

  test("a signed body with one byte changed is refused", async () => {
    const { env, stripe, deliver } = setup();
    const body = thinEvent(COMPLETED, stripe.addSession());
    const header = await signedHeader(body, env.STRIPE_WEBHOOK_SECRET);
    const bytes = new TextEncoder().encode(body);
    bytes[bytes.length - 2] = bytes[bytes.length - 2] === 0x31 ? 0x32 : 0x31;
    expect((await deliver(bytes, header)).status).toBe(400);
    expect(stripe.calls).toBe(0);
  });

  test("a request without the header is refused", async () => {
    const { stripe, deliver } = setup();
    expect((await deliver(thinEvent(COMPLETED, stripe.addSession()))).status).toBe(400);
    expect(stripe.calls).toBe(0);
  });

  test("a signature 301 seconds old is refused", async () => {
    const { stripe, signed } = setup();
    const response = await signed(thinEvent(COMPLETED, stripe.addSession()), Math.floor(Date.now() / 1000) - 301);
    expect(response.status).toBe(400);
    expect(stripe.calls).toBe(0);
  });

  test("a snapshot event is refused, because the destination sends thin events", async () => {
    const { stripe, signed } = setup();
    const body = JSON.stringify({ id: "evt_1", object: "event", type: "checkout.session.completed", data: { object: { id: stripe.addSession() } } });
    expect((await signed(body)).status).toBe(400);
    expect(stripe.calls).toBe(0);
  });

  test("another method gets 405, and a body over 64 KiB gets 413", async () => {
    const { env, stripe } = setup();
    const get = await handleWebhook(request("GET", "/api/stripe-webhook"), deps(env, stripe));
    expect(get.status).toBe(405);
    const large = await handleWebhook(request("POST", "/api/stripe-webhook", "x".repeat(65_537)), deps(env, stripe));
    expect(large.status).toBe(413);
  });
});

describe("Events handled", () => {
  test("a delayed payment issues nothing when completed, and the key when it succeeds later", async () => {
    const { stripe, signed, logs } = setup();
    const id = stripe.addSession({ paymentStatus: "unpaid" });
    expect((await signed(thinEvent(COMPLETED, id))).status).toBe(200);
    expect(stripe.updates).toEqual([]);
    expect(logs.at(-1)!.fields.outcome).toBe("pending");
    stripe.update(id, { payment_status: "paid" });
    expect((await signed(thinEvent("v1.checkout.session.async_payment_succeeded", id))).status).toBe(200);
    expect(stripe.updates).toHaveLength(1);
    expect(logs.at(-1)!.fields.outcome).toBe("issued");
  });

  test("a failed delayed payment is logged and accepted", async () => {
    const { stripe, signed, logs } = setup();
    const id = stripe.addSession({ paymentStatus: "unpaid" });
    expect((await signed(thinEvent("v1.checkout.session.async_payment_failed", id))).status).toBe(200);
    expect(stripe.calls).toBe(0);
    expect(logs.at(-1)).toMatchObject({ message: "payment failed", fields: { session_id: id } });
  });

  test("another event type is accepted and ignored", async () => {
    const { stripe, signed } = setup();
    expect((await signed(thinEvent("v1.checkout.session.expired", stripe.addSession()))).status).toBe(200);
    expect(stripe.calls).toBe(0);
  });

  test("an event from the other mode is accepted and logged, and nothing is issued", async () => {
    const { stripe, signed, logs } = setup("test");
    expect((await signed(thinEvent(COMPLETED, stripe.addSession(), true))).status).toBe(200);
    expect(stripe.calls).toBe(0);
    expect(logs.at(-1)).toMatchObject({ level: "warn", message: "webhook mode differs" });
  });

  test("a rejected session is accepted and logged as an error", async () => {
    const { stripe, signed, logs } = setup();
    const id = stripe.addSession({ priceId: "price_Other" });
    expect((await signed(thinEvent(COMPLETED, id))).status).toBe(200);
    expect(logs.at(-1)).toMatchObject({ level: "error", fields: { outcome: "rejected: line_items" } });
  });

  test("a connection error while retrieving the session gets 500, so Stripe retries", async () => {
    const { stripe, signed } = setup();
    const id = stripe.addSession();
    stripe.failure = "network";
    expect((await signed(thinEvent(COMPLETED, id))).status).toBe(500);
  });

  test("wrong settings get 503 before the signature is read", async () => {
    const { stripe } = setup();
    const response = await handleWebhook(request("POST", "/api/stripe-webhook", "{}"), deps({}, stripe));
    expect([response.status, JSON.parse(response.body)]).toEqual([503, { error: "not_configured" }]);
  });
});

describe("Nothing secret leaves the server", () => {
  test("no setting value, raw body, email address or key text appears in a response or a log line", async () => {
    const { env, stripe, logs, deliver, signed } = setup();
    const id = stripe.addSession();
    const body = thinEvent(COMPLETED, id);
    const responses = [
      await signed(body),
      await deliver(body, await signedHeader(body, "whsec_" + "other" + crypto.randomUUID())),
      await signed(thinEvent(COMPLETED, stripe.addSession({ paymentStatus: "unpaid" }))),
      await signed(thinEvent("v1.checkout.session.async_payment_failed", id)),
      await handleCheckout(request("POST", "/api/checkout"), deps(env, stripe, logs)),
      await handleLicense(request("GET", `/api/license?session_id=${id}`), deps(env, stripe, logs)),
    ];
    stripe.failure = "network";
    responses.push(
      await signed(body),
      await handleCheckout(request("POST", "/api/checkout"), deps(env, stripe, logs)),
      await handleLicense(request("GET", `/api/license?session_id=${id}`), deps(env, stripe, logs)),
    );
    const key = JSON.parse(responses[5]!.body).key as string;
    const responseText = responses.map((response) => response.body + JSON.stringify(response.headers)).join("\n");
    const logText = JSON.stringify(logs);
    for (const value of Object.values(env)) {
      expect(responseText).not.toContain(value);
      expect(logText).not.toContain(value);
    }
    for (const text of [responseText, logText]) {
      expect(text).not.toContain(BUYER_EMAIL);
      expect(text).not.toContain(body);
    }
    expect(logText).not.toContain(key);
    expect(logText).not.toContain(key.split(".")[2]!);
  });
});
