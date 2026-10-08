// Checks a provider's policy file (add-provider-adapters, design decision 12; the
// provider-policies spec). The fields are snake_case in the file and camelCase in ProviderPolicy.
import { PROVIDERS } from "../adapters/providers";
import type { ProviderId, ProviderPolicy } from "../adapters/types";

export class PolicyError extends Error {}

const FIELDS = [
  "provider", "display_name", "company", "checked_on", "max_age_days", "sign_in_methods", "unattended_subscription_use",
  "same_provider_automatic_switching", "own_accounts_note", "usage_signals", "summary", "unclear", "terms",
] as const;
const UNATTENDED = ["allowed", "api_key_only", "unclear"];
const MAX_AGE_DAYS = 90;

type Table = Record<string, unknown>;

const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const isTextList = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every(isText);

// `file` names the policy in every message, for example "src/adapters/codex/policy.toml".
export function parsePolicy(raw: unknown, file: string): ProviderPolicy {
  const fail = (message: string): never => {
    throw new PolicyError(`${file}: ${message}`);
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("the file must be a TOML table.");
  const table = raw as Table;
  const unknown = Object.keys(table).find((key) => !(FIELDS as readonly string[]).includes(key));
  if (unknown !== undefined) fail(`${unknown} is not a policy field.`);
  for (const field of FIELDS) if (!Object.hasOwn(table, field)) fail(`${field} is required.`);

  if (!(PROVIDERS as readonly unknown[]).includes(table.provider)) fail(`provider must be one of ${PROVIDERS.join(", ")}.`);
  for (const field of ["display_name", "company", "own_accounts_note", "summary", "unclear"] as const) {
    if (!isText(table[field])) fail(`${field} must be text.`);
  }
  const checkedOn = table.checked_on;
  if (typeof checkedOn !== "string" || !isCalendarDate(checkedOn)) fail("checked_on must be a date such as 2026-10-07, in quotes.");
  const maxAge = table.max_age_days;
  if (!Number.isInteger(maxAge) || (maxAge as number) < 1 || (maxAge as number) > MAX_AGE_DAYS) {
    fail(`max_age_days must be a whole number from 1 to ${MAX_AGE_DAYS}.`);
  }
  for (const field of ["sign_in_methods", "usage_signals"] as const) {
    if (!isTextList(table[field])) fail(`${field} must be a list of texts with at least one entry.`);
  }
  if (!UNATTENDED.includes(table.unattended_subscription_use as string)) {
    fail("unattended_subscription_use must be allowed, api_key_only or unclear.");
  }
  if (table.same_provider_automatic_switching !== "off") fail("same_provider_automatic_switching must be off.");
  const terms = table.terms;
  if (!Array.isArray(terms) || terms.length === 0) fail("at least one [[terms]] entry is required.");
  const parsedTerms = (terms as unknown[]).map((entry, index) => {
    const where = `terms entry ${index + 1}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return fail(`${where} must be a table.`);
    const { title, url, ...rest } = entry as Table;
    if (Object.keys(rest).length > 0) fail(`${where} has fields other than title and url.`);
    if (!isText(title)) fail(`${where} needs a title.`);
    if (typeof url !== "string" || !url.startsWith("https://")) fail(`${where} needs a url that starts with https://.`);
    return { title: title as string, url: url as string };
  });

  return {
    provider: table.provider as ProviderId,
    displayName: table.display_name as string,
    company: table.company as string,
    checkedOn: checkedOn as string,
    maxAgeDays: maxAge as number,
    signInMethods: table.sign_in_methods as string[],
    unattendedSubscriptionUse: table.unattended_subscription_use as string,
    sameProviderAutomaticSwitching: "off",
    ownAccountsNote: table.own_accounts_note as string,
    usageSignals: table.usage_signals as string[],
    summary: (table.summary as string).trim(),
    unclear: (table.unclear as string).trim(),
    terms: parsedTerms,
  };
}

function isCalendarDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) return false;
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
