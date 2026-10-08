// How an account's availability is reported (design.md decision 19), shared by the API and, later,
// relay status. A limit whose reset time has passed is reported as unknown: relay knows the limit
// should be over but has not seen proof.

export const AVAILABILITY_STATUSES = ["available", "rate_limited", "quota_exhausted", "unavailable", "unknown"] as const;
export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];

export interface Availability {
  status: AvailabilityStatus;
  reason: string | null;
  retry_at: string | null;
  measured_at: string | null;
  source: string | null;
}

export const STALE_REASON = "The reset time has passed; relay has not checked since.";

export function reportedAvailability(stored: Availability, now: Date): Availability {
  const limited = stored.status === "rate_limited" || stored.status === "quota_exhausted";
  if (limited && stored.retry_at !== null && Date.parse(stored.retry_at) <= now.getTime()) {
    return { ...stored, status: "unknown", reason: STALE_REASON };
  }
  return stored;
}

export function isAvailabilityStatus(value: unknown): value is AvailabilityStatus {
  return (AVAILABILITY_STATUSES as readonly unknown[]).includes(value);
}
