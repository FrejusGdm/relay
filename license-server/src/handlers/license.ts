// GET /api/license?session_id=<id> (add-lifetime-license, design decision 7): runs the fulfillment
// function for the license page and answers with the key or the state of the payment.
import { fulfillCheckout } from "../core/fulfill";
import { errorName, json, notConfigured, type Deps, type PlainRequest, type PlainResponse } from "../core/http";

export async function handleLicense(request: PlainRequest, deps: Deps): Promise<PlainResponse> {
  if (request.method !== "GET") return json(405, { error: "method_not_allowed" }, { Allow: "GET" });
  if (!deps.settings.ok) return notConfigured(deps.log, deps.settings.problems);
  const { settings } = deps.settings;

  const sessionId = new URL(request.url).searchParams.get("session_id") ?? "";
  try {
    const result = await fulfillCheckout(sessionId, { settings, stripe: deps.stripe(settings) });
    switch (result.state) {
      case "issued":
        return json(200, { state: "issued", key: result.key, license: result.licenseId, issued: result.issued });
      case "pending":
        return json(202, { state: "pending" });
      case "rejected":
        deps.log("error", "license rejected", { reason: result.reason });
        return json(404, { state: "not_found" });
      case "not_found":
        return json(404, { state: "not_found" });
    }
  } catch (error) {
    deps.log("error", "license failed", { error_name: errorName(error) });
    return json(503, { state: "error" });
  }
}
