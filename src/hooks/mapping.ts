// What a provider hook event says about an account's availability (design.md decision 18, the
// availability table). relay status uses it for hook events spooled while the daemon was down;
// task group 8 adds the worker and job lookup for the daemon's own hook queue.
import type { AvailabilityStatus } from "../state/availability";

export interface HookAvailability {
  status: AvailabilityStatus;
  reason: string;
}

const CLAUDE_STOP_FAILURES: Record<string, HookAvailability> = {
  rate_limit: { status: "rate_limited", reason: "Claude Code reported a rate limit" },
  billing_error: { status: "unavailable", reason: "Claude Code reported a billing problem" },
  authentication_failed: { status: "unavailable", reason: "Claude Code is signed out of this account" },
  oauth_org_not_allowed: { status: "unavailable", reason: "This organization does not allow this login" },
  account_on_hold: { status: "unavailable", reason: "Claude Code reported that the account is on hold" },
};

// The new availability, or null when the event changes none (for example overloaded or
// server_error, which are outages of the service, not of the account).
export function availabilityFromHook(provider: string, event: string, fields: Record<string, unknown>): HookAvailability | null {
  if (provider === "claude" && event === "StopFailure") {
    return typeof fields.error === "string" ? (CLAUDE_STOP_FAILURES[fields.error] ?? null) : null;
  }
  if ((provider === "claude" || provider === "codex") && event === "Stop") {
    return { status: "available", reason: "The last turn finished normally" };
  }
  if (provider === "claude" && event === "Notification" && fields.notification_type === "quota_auto_resume_fired") {
    return { status: "available", reason: "Claude Code continued after its reset." };
  }
  return null;
}
