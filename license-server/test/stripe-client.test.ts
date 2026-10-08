// The Stripe client of design decision 3, read without sending a request.
import { expect, test } from "bun:test";
import { createStripeClient } from "../src/core/stripe-client";
import { loadSettings } from "../src/core/settings";
import { serverEnv } from "./helpers";

test("the client pins the API version, turns telemetry off and limits retries and time", () => {
  const result = loadSettings(serverEnv("test").env);
  if (!result.ok) throw new Error("the test settings are not valid");
  const client = createStripeClient(result.settings);
  expect(client.getApiField("version")).toBe("2026-09-30.endive");
  expect(client.getTelemetryEnabled()).toBe(false);
  expect(client.getMaxNetworkRetries()).toBe(2);
  expect(client.getApiField("timeout")).toBe(8000);
});
