// Turns the hook events of an interactive Claude Code session into worker events.
import type { SpoolLine } from "../../hooks/fields";
import type { FailureReason, WorkerEvent } from "../types";

export function claudeHookEvents(line: SpoolLine): WorkerEvent[] {
  if (line.event === "StopFailure") {
    const error = typeof line.fields.error === "string" ? line.fields.error : "unknown";
    const reasons: Record<string, FailureReason> = {
      rate_limit: "rate_limit", overloaded: "overloaded", authentication_failed: "auth",
      oauth_org_not_allowed: "auth", billing_error: "billing",
    };
    return [{ kind: "turn_failed", reason: reasons[error] ?? "other", message: `Claude Code stopped: ${error}.`, source: "hook" }];
  }
  if (line.event === "Stop") return [{ kind: "turn_completed" }];
  if (line.event === "Notification" && line.fields.notification_type === "quota_auto_resume_fired") {
    return [{ kind: "limit_update", windows: [], state: "available", source: "hook" }];
  }
  return [];
}
