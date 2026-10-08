// Runs only in the test-mode run (add-lifetime-license, task 8.2), with a real key from Stripe test
// mode and its test-1 public key in the environment. It proves that relay rejects a real test-mode
// key with exit 50, instead of stopping at the empty built-in table with exit 69.
import { expect, test } from "bun:test";
import { runRelayInProcess } from "../helpers/cli";

const key = process.env.RELAY_TEST_LICENSE_KEY;
const publicKey = process.env.RELAY_TEST_LICENSE_PUBLIC_KEY;

test.skipIf(!key || !publicKey)("a real test-mode key is refused as a test key", async () => {
  expect(await runRelayInProcess(["license", "activate", key!], { licensePublicKeys: { "test-1": publicKey! } })).toEqual({
    code: 50,
    stdout: "",
    stderr: "relay: this license key comes from Stripe test mode and does not unlock relay.\n",
  });
});
