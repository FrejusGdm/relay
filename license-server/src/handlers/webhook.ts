// POST /api/stripe-webhook (add-lifetime-license, design decision 5): checks the signature of a
// thin event notification and runs the fulfillment function for completed or succeeded sessions.
import { fulfillCheckout } from "../core/fulfill";
import { errorName, json, notConfigured, type Deps, type PlainRequest, type PlainResponse } from "../core/http";
import type { EventNotice } from "../core/stripe-client";

const MAX_BODY = 65_536;
const FULFILL = new Set(["v1.checkout.session.completed", "v1.checkout.session.async_payment_succeeded"]);

export async function handleWebhook(request: PlainRequest, deps: Deps): Promise<PlainResponse> {
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, { Allow: "POST" });
  if (request.body.byteLength > MAX_BODY) return json(413, { error: "too_large" });
  // 503 makes Stripe retry after the settings are fixed.
  if (!deps.settings.ok) return notConfigured(deps.log, deps.settings.problems);
  const { settings } = deps.settings;
  const stripe = deps.stripe(settings);

  // The raw bytes, never parsed first: any change to the body breaks the signature check.
  let notice: EventNotice;
  try {
    notice = await stripe.parseEventNotification(Buffer.from(request.body), request.headers.get("stripe-signature") ?? "");
  } catch {
    deps.log("warn", "webhook rejected");
    return json(400, { error: "invalid_signature" });
  }
  const fields = { event_id: notice.id, event_type: notice.type, session_id: notice.relatedObjectId };

  if (notice.livemode !== (settings.mode === "live")) {
    deps.log("warn", "webhook mode differs", { ...fields, outcome: "ignored" });
    return json(200, { received: true });
  }
  if (notice.type === "v1.checkout.session.async_payment_failed") {
    deps.log("info", "payment failed", { ...fields, outcome: "failed" });
    return json(200, { received: true });
  }
  if (!FULFILL.has(notice.type) || notice.relatedObjectId === null) {
    deps.log("info", "webhook ignored", { ...fields, outcome: "ignored" });
    return json(200, { received: true });
  }

  try {
    const result = await fulfillCheckout(notice.relatedObjectId, { settings, stripe });
    const licenseId = result.state === "issued" ? result.licenseId : null;
    const outcome = result.state === "rejected" ? `rejected: ${result.reason}` : result.state;
    deps.log(result.state === "rejected" ? "error" : "info", "webhook handled", { ...fields, outcome, license_id: licenseId });
    return json(200, { received: true });
  } catch (error) {
    // 500 makes Stripe retry the delivery.
    deps.log("error", "webhook failed", { ...fields, outcome: "error", error_name: errorName(error) });
    return json(500, { error: "stripe_unavailable" });
  }
}
