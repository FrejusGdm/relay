// Registers the three HTTP functions with the Azure Functions Node.js library (v4 programming
// model). This is the only file that imports @azure/functions; the handlers take plain requests.
import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import type { Deps, Log, PlainRequest, PlainResponse } from "./core/http";
import { loadSettings, type Settings } from "./core/settings";
import { createStripeApi, type StripeApi } from "./core/stripe-client";
import { handleCheckout } from "./handlers/checkout";
import { handleLicense } from "./handlers/license";
import { handleWebhook } from "./handlers/webhook";

type Handler = (request: PlainRequest, deps: Deps) => Promise<PlainResponse>;

// One Stripe client per function instance, made again only when the key changes.
let client: { apiKey: string; api: StripeApi } | null = null;
function stripeFor(settings: Settings): StripeApi {
  if (client?.apiKey !== settings.apiKey) client = { apiKey: settings.apiKey, api: createStripeApi(settings) };
  return client.api;
}

function logTo(context: InvocationContext): Log {
  return (level, message, fields = {}) => {
    const line = JSON.stringify({ message, ...fields });
    if (level === "error") context.error(line);
    else if (level === "warn") context.warn(line);
    else context.log(line);
  };
}

function wrap(handler: Handler) {
  return async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    // The raw bytes, before anything parses them, for the webhook's signature check.
    const body = new Uint8Array(await request.arrayBuffer());
    const response = await handler(
      { method: request.method, url: request.url, headers: request.headers, body },
      { settings: loadSettings(process.env), stripe: stripeFor, log: logTo(context) },
    );
    return { status: response.status, headers: response.headers, body: response.body };
  };
}

// The other method is registered so that the handler, not the runtime, answers 405.
app.http("checkout", { route: "checkout", methods: ["POST", "GET"], authLevel: "anonymous", handler: wrap(handleCheckout) });
app.http("stripe-webhook", { route: "stripe-webhook", methods: ["POST", "GET"], authLevel: "anonymous", handler: wrap(handleWebhook) });
app.http("license", { route: "license", methods: ["GET", "POST"], authLevel: "anonymous", handler: wrap(handleLicense) });
