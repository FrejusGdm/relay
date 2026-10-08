// The license-command spec, "No network and no secrets in logs": relay license never opens a
// network connection. test/build/no-network.test.ts also checks the source of src/license/.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { runRelayInProcess } from "../helpers/cli";
import { makeRelayHome } from "../helpers/home";
import { keyPair, licenseKey, table } from "./keys";

const realFetch = globalThis.fetch;
const calls: unknown[] = [];

beforeEach(() => {
  calls.length = 0;
  globalThis.fetch = Object.assign((...args: unknown[]) => {
    calls.push(args);
    return Promise.reject(new Error("no network in this test"));
  }, { preconnect: () => {} }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("activate, status and remove make no network call", async () => {
  const pair = keyPair("live-1");
  const relayHome = makeRelayHome();
  const options = { relayHome, licensePublicKeys: table(pair) };
  expect((await runRelayInProcess(["license", "activate", licenseKey(pair)], options)).code).toBe(0);
  expect((await runRelayInProcess(["license", "status"], options)).code).toBe(0);
  expect((await runRelayInProcess(["license", "remove"], options)).code).toBe(0);
  expect((await runRelayInProcess(["license", "status"], options)).code).toBe(51);
  expect(calls).toEqual([]);
});
