import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { POLICY_FILES, policyOf } from "../../src/policies/load";
import { parsePolicy } from "../../src/policies/schema";

const ROOT = join(import.meta.dir, "..", "..");
const raw = (provider: "claude" | "codex") =>
  Bun.TOML.parse(readFileSync(join(ROOT, POLICY_FILES[provider]), "utf8")) as Record<string, unknown>;

test("both policy files load with their links and check dates", () => {
  for (const provider of ["claude", "codex"] as const) {
    const policy = policyOf(provider);
    expect(policy.provider).toBe(provider);
    expect(policy.checkedOn).toBe("2026-10-07");
    expect(policy.maxAgeDays).toBe(90);
    expect(policy.sameProviderAutomaticSwitching).toBe("off");
    expect(policy.terms.length).toBeGreaterThan(0);
    for (const term of policy.terms) expect(term.url.startsWith("https://")).toBe(true);
  }
  expect(policyOf("claude").unattendedSubscriptionUse).toBe("unclear");
  expect(policyOf("codex").unattendedSubscriptionUse).toBe("allowed");
  expect(policyOf("codex").terms[0]).toEqual({ title: "OpenAI Terms of Use", url: "https://openai.com/policies/terms-of-use/" });
});

test("a copy without checked_on is refused with the file name", () => {
  const copy = raw("codex");
  delete copy.checked_on;
  expect(() => parsePolicy(copy, POLICY_FILES.codex)).toThrow("src/adapters/codex/policy.toml: checked_on is required.");
});

test("other broken copies are refused", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ ...raw("claude"), same_provider_automatic_switching: "on" }, "same_provider_automatic_switching must be off."],
    [{ ...raw("claude"), checked_on: "2026-02-30" }, "checked_on must be a date"],
    [{ ...raw("claude"), terms: [] }, "at least one [[terms]] entry is required."],
    [{ ...raw("claude"), terms: [{ title: "Terms", url: "http://example.com" }] }, "terms entry 1 needs a url"],
    [{ ...raw("claude"), unattended_subscription_use: "yes" }, "unattended_subscription_use must be"],
    [{ ...raw("claude"), extra: 1 }, "extra is not a policy field."],
  ];
  for (const [copy, message] of cases) expect(() => parsePolicy(copy, POLICY_FILES.claude)).toThrow(message);
});
