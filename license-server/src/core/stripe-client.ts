// The Stripe calls the server makes (add-lifetime-license, design decision 3). The rest of the
// code uses only the StripeApi interface, so tests pass a fake and never call Stripe.
import Stripe from "stripe";
import type { Settings } from "./settings";

export interface EventNotice {
  id: string;
  type: string;
  livemode: boolean;
  relatedObjectId: string | null;
}

export interface StripeApi {
  createCheckoutSession(params: Stripe.Checkout.SessionCreateParams): Promise<{ id: string; url: string | null }>;
  // Retrieves the session with its line items and its PaymentIntent expanded.
  retrieveCheckoutSession(id: string): Promise<Stripe.Checkout.Session>;
  recordLicense(paymentIntentId: string, metadata: Record<string, string>, idempotencyKey: string): Promise<void>;
  // Rejects when the signature does not match the raw body, or the timestamp is older than 300 seconds.
  parseEventNotification(rawBody: Buffer, signature: string): Promise<EventNotice>;
}

export function createStripeClient(settings: Settings): Stripe {
  return new Stripe(settings.apiKey, {
    apiVersion: "2026-09-30.endive",
    maxNetworkRetries: 2,
    timeout: 8000,
    // Stops the library from sending request timing data to Stripe (relay sends no telemetry).
    telemetry: false,
    appInfo: { name: "relay-license-server", version: "0.1.0" },
  });
}

export function createStripeApi(settings: Settings, client: Stripe = createStripeClient(settings)): StripeApi {
  return {
    async createCheckoutSession(params) {
      const session = await client.checkout.sessions.create(params);
      return { id: session.id, url: session.url };
    },
    retrieveCheckoutSession(id) {
      return client.checkout.sessions.retrieve(id, { expand: ["line_items", "payment_intent"] });
    },
    async recordLicense(paymentIntentId, metadata, idempotencyKey) {
      await client.paymentIntents.update(paymentIntentId, { metadata }, { idempotencyKey });
    },
    parseEventNotification(rawBody, signature) {
      return parseNotice(client, rawBody, signature, settings.webhookSecret);
    },
  };
}

// Verifies the signature before it parses anything, with the library's default tolerance of 300
// seconds. A snapshot event (object "event") is refused by the library. The asynchronous form works
// with every crypto provider of the library: under Bun it loads its worker build, whose Web Crypto
// provider cannot verify synchronously.
export async function parseNotice(client: Stripe, rawBody: Buffer, signature: string, secret: string): Promise<EventNotice> {
  const notice = await client.parseEventNotificationAsync(rawBody, signature, secret);
  const related = (notice as { related_object?: { id?: unknown } | null }).related_object;
  return {
    id: notice.id,
    type: notice.type,
    livemode: notice.livemode,
    relatedObjectId: typeof related?.id === "string" ? related.id : null,
  };
}
