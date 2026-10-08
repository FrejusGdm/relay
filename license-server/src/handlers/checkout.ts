// POST /api/checkout (add-lifetime-license, design decision 4): creates a Stripe Checkout Session
// in payment mode for one license and sends the buyer to Stripe's hosted payment page.
import { randomBytes } from "node:crypto";
import { errorName, html, json, notConfigured, redirect, type Deps, type PlainRequest, type PlainResponse } from "../core/http";

export async function handleCheckout(request: PlainRequest, deps: Deps): Promise<PlainResponse> {
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, { Allow: "POST" });
  if (!deps.settings.ok) return notConfigured(deps.log, deps.settings.problems);
  const { settings } = deps.settings;

  // Created before payment, so the key is a pure function of the session.
  const licenseId = randomBytes(8).toString("hex");
  const metadata = { relay_product: "relay-lifetime", relay_license_id: licenseId };
  try {
    const session = await deps.stripe(settings).createCheckoutSession({
      mode: "payment",
      line_items: [{ price: settings.priceId, quantity: 1 }],
      success_url: `${settings.siteUrl}/license/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${settings.siteUrl}/#buy`,
      submit_type: "pay",
      metadata,
      payment_intent_data: { metadata },
      integration_identifier: "relay-lifetime-checkout-qhvbtmzr",
    });
    if (session.url === null) throw new Error("the Checkout Session has no URL");
    deps.log("info", "checkout started", { session_id: session.id, license_id: licenseId });
    return redirect(session.url);
  } catch (error) {
    deps.log("error", "checkout failed", { error_name: errorName(error) });
    return html(502, "Payment could not start", [
      "Payment could not start. Nothing was charged. Try again in a minute.",
      '<a href="/#buy">Back to relay</a>',
    ]);
  }
}

