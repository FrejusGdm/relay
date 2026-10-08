// Lists every provider policy whose checked_on is older than its max_age_days, or in the future,
// and exits 1 when there is one, so the policies are checked again before a release (the
// provider-policies spec, "Stale policies are flagged"). Run it with: bun run scripts/check-policies.ts
import { PROVIDERS } from "../src/adapters/providers";
import { isFutureDate, isStale, POLICY_FILES, policyAgeDays, policyOf } from "../src/policies/load";

export function policyProblemLines(): string[] {
  return PROVIDERS.map(policyOf).flatMap((policy) => {
    if (isFutureDate(policy)) {
      return [`${POLICY_FILES[policy.provider]} has checked_on ${policy.checkedOn}, a date in the future. Write the date the ${policy.displayName} terms were last read.`];
    }
    if (!isStale(policy)) return [];
    return [`${POLICY_FILES[policy.provider]} was last checked on ${policy.checkedOn}, ${policyAgeDays(policy)} days ago ` +
      `(more than ${policy.maxAgeDays}). Check the ${policy.displayName} terms again and update checked_on.`];
  });
}

if (import.meta.main) {
  const lines = policyProblemLines();
  if (lines.length > 0) {
    process.stderr.write(lines.map((line) => `${line}\n`).join(""));
    process.exit(1);
  }
  process.stdout.write("Every provider policy was checked within its max_age_days.\n");
}
