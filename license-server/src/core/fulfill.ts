// The fulfillment function (add-lifetime-license, design decision 6), after Stripe's guide
// https://docs.stripe.com/checkout/fulfillment. The webhook and the license page both run it. It is
// safe to run many times, even at the same moment: it only reads the session, the key depends only
// on the session and the signing key, and the one write is the same each time, under one
// idempotency key per session and signing key.
import type Stripe from "stripe";
import { signLicenseKey } from "./sign";
import type { Settings } from "./settings";
import type { StripeApi } from "./stripe-client";

export type RejectReason = "mode" | "livemode" | "product" | "license_id" | "line_items";

export type FulfillResult =
  | { state: "issued"; key: string; licenseId: string; issued: string }
  | { state: "pending" }
  | { state: "not_found" }
  | { state: "rejected"; reason: RejectReason };

export interface FulfillDeps {
  settings: Settings;
  stripe: StripeApi;
}

export async function fulfillCheckout(sessionId: string, deps: FulfillDeps): Promise<FulfillResult> {
  const { settings, stripe } = deps;
  const id = /^cs_(test|live)_[A-Za-z0-9]{10,240}$/.exec(sessionId);
  if (id === null || id[1] !== settings.mode) return { state: "not_found" };

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.retrieveCheckoutSession(sessionId);
  } catch (error) {
    if ((error as { code?: unknown }).code === "resource_missing") return { state: "not_found" };
    throw error;
  }

  const reason = rejectReason(session, settings);
  if (reason !== null) return { state: "rejected", reason };
  if (session.status !== "complete") return { state: "not_found" };
  if (session.payment_status === "unpaid") return { state: "pending" };

  const licenseId = session.metadata!.relay_license_id!;
  const issued = new Date(session.created * 1000).toISOString().slice(0, 10);
  const key = signLicenseKey({ kid: settings.kid, privateKey: settings.signingKey, licenseId, issued });

  const intent = session.payment_intent;
  if (intent !== null && typeof intent === "object") {
    const recorded = intent.metadata ?? {};
    if (recorded.relay_license_issued !== issued || recorded.relay_license_key_id !== settings.kid) {
      await stripe.recordLicense(
        intent.id,
        { relay_license_issued: issued, relay_license_key_id: settings.kid },
        `relay-license-${session.id}-${settings.kid}`,
      );
    }
  }
  return { state: "issued", key, licenseId, issued };
}

// The first check that fails, in the design's order. Every price that ever sold a license is
// accepted, so a buyer from an earlier price keeps getting the key.
function rejectReason(session: Stripe.Checkout.Session, settings: Settings): RejectReason | null {
  if (session.mode !== "payment") return "mode";
  if (session.livemode !== (settings.mode === "live")) return "livemode";
  if (session.metadata?.relay_product !== "relay-lifetime") return "product";
  if (!/^[0-9a-f]{16}$/.test(session.metadata?.relay_license_id ?? "")) return "license_id";
  const items = session.line_items?.data ?? [];
  const item = items[0];
  if (items.length !== 1 || item === undefined || item.quantity !== 1) return "line_items";
  if (!settings.licensePriceIds.includes(item.price?.id ?? "")) return "line_items";
  return null;
}
