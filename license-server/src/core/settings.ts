// The server's seven application settings (add-lifetime-license, design decision 2). Problems are
// reported by setting name only: no value is ever logged, returned or echoed.
import { createPrivateKey, type KeyObject } from "node:crypto";

export type Mode = "test" | "live";

export interface Settings {
  mode: Mode;
  apiKey: string;
  webhookSecret: string;
  priceId: string;
  licensePriceIds: string[];
  signingKey: KeyObject;
  kid: string;
  siteUrl: string;
}

export type SettingsResult = { ok: true; settings: Settings } | { ok: false; problems: string[] };

export const SETTING_NAMES = [
  "STRIPE_API_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "RELAY_STRIPE_PRICE_ID",
  "RELAY_LICENSE_PRICE_IDS",
  "RELAY_LICENSE_SIGNING_KEY",
  "RELAY_LICENSE_KEY_ID",
  "RELAY_SITE_URL",
] as const;

export function loadSettings(env: Record<string, string | undefined>): SettingsResult {
  const problems = new Set<string>();
  const value = (name: (typeof SETTING_NAMES)[number]) => {
    const text = env[name]?.trim() ?? "";
    if (text === "") problems.add(name);
    return text;
  };
  const apiKey = value("STRIPE_API_KEY");
  const webhookSecret = value("STRIPE_WEBHOOK_SECRET");
  const priceId = value("RELAY_STRIPE_PRICE_ID");
  const priceList = value("RELAY_LICENSE_PRICE_IDS");
  const signingKeyText = value("RELAY_LICENSE_SIGNING_KEY");
  const kid = value("RELAY_LICENSE_KEY_ID");
  const siteUrl = value("RELAY_SITE_URL");

  // A secret key (sk_) can do anything on the account, so only a restricted key is accepted.
  const mode: Mode | null = apiKey.startsWith("rk_test_") ? "test" : apiKey.startsWith("rk_live_") ? "live" : null;
  if (apiKey !== "" && mode === null) problems.add("STRIPE_API_KEY");

  if (kid !== "") {
    const match = /^(test|live)-[0-9]+$/.exec(kid);
    if (match === null || (mode !== null && match[1] !== mode)) problems.add("RELAY_LICENSE_KEY_ID");
  }

  if (webhookSecret !== "" && !webhookSecret.startsWith("whsec_")) problems.add("STRIPE_WEBHOOK_SECRET");
  if (priceId !== "" && !isPriceId(priceId)) problems.add("RELAY_STRIPE_PRICE_ID");
  const licensePriceIds = priceList.split(",").map((entry) => entry.trim());
  if (priceList !== "" && (!licensePriceIds.every(isPriceId) || !licensePriceIds.includes(priceId))) {
    problems.add("RELAY_LICENSE_PRICE_IDS");
  }

  let signingKey: KeyObject | null = null;
  if (signingKeyText !== "") {
    try {
      const key = createPrivateKey({ key: Buffer.from(signingKeyText, "base64"), format: "der", type: "pkcs8" });
      if (key.asymmetricKeyType === "ed25519") signingKey = key;
    } catch {
      signingKey = null;
    }
    if (signingKey === null) problems.add("RELAY_LICENSE_SIGNING_KEY");
  }

  if (siteUrl !== "" && !siteUrlAllowed(siteUrl, mode)) problems.add("RELAY_SITE_URL");

  if (problems.size > 0 || mode === null || signingKey === null) {
    return { ok: false, problems: SETTING_NAMES.filter((name) => problems.has(name)) };
  }
  return { ok: true, settings: { mode, apiKey, webhookSecret, priceId, licensePriceIds, signingKey, kid, siteUrl } };
}

function isPriceId(text: string): boolean {
  return /^price_[A-Za-z0-9]+$/.test(text);
}

// https:// always; http://localhost:<port> only in test mode, for the local smoke test. No final "/".
function siteUrlAllowed(url: string, mode: Mode | null): boolean {
  if (url.endsWith("/")) return false;
  if (/^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?$/.test(url)) return true;
  return mode === "test" && /^http:\/\/localhost:[0-9]+$/.test(url);
}
