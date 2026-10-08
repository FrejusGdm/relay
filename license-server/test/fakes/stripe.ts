// FakeStripeApi (add-lifetime-license, design decision 14): answers like the Stripe API from the
// shapes of its Checkout Session and PaymentIntent objects (the response examples at
// https://docs.stripe.com/api/checkout/sessions/retrieve), counts its calls and never touches the
// network. Webhook signatures are checked with the real Stripe library, which needs no network.
import { randomBytes } from "node:crypto";
import Stripe from "stripe";
import { parseNotice, type EventNotice, type StripeApi } from "../../src/core/stripe-client";

export interface SessionOptions {
  mode?: "test" | "live";
  status?: "open" | "complete" | "expired";
  paymentStatus?: "paid" | "unpaid" | "no_payment_required";
  checkoutMode?: "payment" | "subscription" | "setup";
  metadata?: Record<string, string>;
  priceId?: string;
  quantity?: number;
  lineItems?: number;
  created?: number;
  withPaymentIntent?: boolean;
  livemode?: boolean;
}

export const BUYER_EMAIL = "buyer@example.com";
export const CREATED = Date.UTC(2026, 9, 7, 23, 30) / 1000;   // 2026-10-07 23:30 UTC

const realClient = new Stripe("rk_" + "test_" + "fake", { telemetry: false });

export class FakeStripeApi implements StripeApi {
  readonly sessions = new Map<string, Stripe.Checkout.Session>();
  readonly intents = new Map<string, Stripe.PaymentIntent>();
  readonly created: Stripe.Checkout.SessionCreateParams[] = [];
  readonly updates: { paymentIntentId: string; metadata: Record<string, string>; idempotencyKey: string }[] = [];
  private readonly idempotent = new Set<string>();
  calls = 0;
  // "network" makes every API call throw a connection error, as the library does when Stripe is down.
  failure: "network" | null = null;

  constructor(private readonly webhookSecret = "") {}

  // Adds a session with the shape Stripe returns, and returns its ID.
  addSession(options: SessionOptions = {}): string {
    const mode = options.mode ?? "test";
    const id = `cs_${mode}_${randomBytes(20).toString("hex")}`;
    const licenseId = randomBytes(8).toString("hex");
    let intent: Stripe.PaymentIntent | null = null;
    if (options.withPaymentIntent !== false) {
      intent = {
        id: `pi_${randomBytes(12).toString("hex")}`,
        object: "payment_intent",
        amount: 9900,
        currency: "usd",
        status: options.paymentStatus === "unpaid" ? "processing" : "succeeded",
        livemode: mode === "live",
        metadata: { relay_product: "relay-lifetime", relay_license_id: licenseId },
        receipt_email: BUYER_EMAIL,
      } as unknown as Stripe.PaymentIntent;
      this.intents.set(intent.id, intent);
    }
    const count = options.lineItems ?? 1;
    const session = {
      id,
      object: "checkout.session",
      mode: options.checkoutMode ?? "payment",
      livemode: options.livemode ?? mode === "live",
      status: options.status ?? "complete",
      payment_status: options.paymentStatus ?? "paid",
      created: options.created ?? CREATED,
      currency: "usd",
      amount_total: 9900,
      customer: null,
      customer_details: { email: BUYER_EMAIL, name: "Test Buyer" },
      metadata: options.metadata ?? { relay_product: "relay-lifetime", relay_license_id: licenseId },
      payment_intent: intent?.id ?? null,
      line_items: {
        object: "list",
        has_more: false,
        url: `/v1/checkout/sessions/${id}/line_items`,
        data: Array.from({ length: count }, (_, i) => ({
          id: `li_${i}${randomBytes(8).toString("hex")}`,
          object: "item",
          quantity: options.quantity ?? 1,
          price: { id: options.priceId ?? "price_A", object: "price", type: "one_time", unit_amount: 9900 },
        })),
      },
    } as unknown as Stripe.Checkout.Session;
    this.sessions.set(id, session);
    return id;
  }

  // Changes a stored session, for example to mark a delayed payment as paid.
  update(id: string, change: Partial<Pick<Stripe.Checkout.Session, "status" | "payment_status">>): void {
    Object.assign(this.sessions.get(id)!, change);
  }

  intentOf(sessionId: string): Stripe.PaymentIntent | null {
    const intentId = this.sessions.get(sessionId)!.payment_intent as string | null;
    return intentId === null ? null : this.intents.get(intentId)!;
  }

  async createCheckoutSession(params: Stripe.Checkout.SessionCreateParams) {
    this.calls++;
    this.throwIfFailing();
    this.created.push(structuredClone(params));
    const id = `cs_test_${randomBytes(20).toString("hex")}`;
    return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
  }

  async retrieveCheckoutSession(id: string): Promise<Stripe.Checkout.Session> {
    this.calls++;
    this.throwIfFailing();
    const session = this.sessions.get(id);
    if (session === undefined) {
      throw new Stripe.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        code: "resource_missing",
        message: `No such checkout.session: '${id}'`,
      });
    }
    // Expanded, as with expand: ["line_items", "payment_intent"].
    const copy = structuredClone(session);
    const intentId = session.payment_intent as string | null;
    copy.payment_intent = intentId === null ? null : structuredClone(this.intents.get(intentId)!);
    return copy;
  }

  async recordLicense(paymentIntentId: string, metadata: Record<string, string>, idempotencyKey: string) {
    this.calls++;
    this.throwIfFailing();
    this.updates.push({ paymentIntentId, metadata: { ...metadata }, idempotencyKey });
    // Stripe returns the saved result for a reused idempotency key and changes nothing.
    if (this.idempotent.has(idempotencyKey)) return;
    this.idempotent.add(idempotencyKey);
    const intent = this.intents.get(paymentIntentId)!;
    intent.metadata = { ...intent.metadata, ...metadata };
  }

  parseEventNotification(rawBody: Buffer, signature: string): Promise<EventNotice> {
    return parseNotice(realClient, rawBody, signature, this.webhookSecret);
  }

  private throwIfFailing(): void {
    if (this.failure === "network") {
      throw new Stripe.errors.StripeConnectionError({
        type: "api_error",
        message: "An error occurred with our connection to Stripe.",
      });
    }
  }
}

// A thin event notification body, as a Stripe event destination with the thin payload sends it.
export function thinEvent(type: string, sessionId: string, livemode = false): string {
  return JSON.stringify({
    id: `evt_test_${randomBytes(12).toString("hex")}`,
    object: "v2.core.event",
    type,
    livemode,
    created: "2026-10-07T23:30:00.000Z",
    related_object: { id: sessionId, type: "checkout_session", url: `/v1/checkout/sessions/${sessionId}` },
  });
}

export function signedHeader(payload: string, secret: string, timestamp?: number): Promise<string> {
  return realClient.webhooks.generateTestHeaderStringAsync({ payload, secret, timestamp });
}
