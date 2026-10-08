// The one list of paid features, and the one rule that decides whether a feature is unlocked
// (add-lifetime-license, design decision 9).
import type { License } from "./key";

export interface PaidFeature {
  id: string;
  name: string;
}

// Josué decides which features are paid (add-lifetime-license, proposal.md, open question 1).
export const PAID_FEATURES: readonly PaidFeature[] = [];

// A lifetime license unlocks every paid feature. This is one function so that a later rule, such as
// "updates until", changes one place.
export function featureUnlocked(feature: PaidFeature, license: License | null): boolean {
  return license !== null;
}
