// The data of the events a handoff appends (add-relay-switch, design decision 20). No event holds
// text an agent wrote, command output, environment values or secrets; the command strings are the
// person's check commands.
import type { CheckResult } from "./checks";
import type { Mismatch } from "./claims";
import type { Verification } from "./verify-file";

export interface PendingEvent {
  type: string;
  data: Record<string, unknown>;
}

export function handoffNotesEvent(input: {
  handoff: number; fromWorkerId: string | null; outcome: "received" | "timed_out" | "failed" | "skipped";
  reason: string | null; seconds: number; characters: number; invisibleRemoved: number;
}): PendingEvent {
  return {
    type: "handoff_notes",
    data: {
      handoff: input.handoff, from_worker_id: input.fromWorkerId, outcome: input.outcome, reason: input.reason,
      seconds: input.seconds, characters: input.characters, invisible_removed: input.invisibleRemoved,
    },
  };
}

export function checkRunEvent(handoff: number, check: CheckResult, relayHome: string): PendingEvent {
  return {
    type: "check_run",
    data: {
      handoff, command: check.command, outcome: check.outcome, exit_code: check.exitCode, signal: check.signal,
      seconds: check.seconds, passed: check.counts?.passed ?? null, failed: check.counts?.failed ?? null,
      skipped: check.counts?.skipped ?? null, log: check.logPath.startsWith(`${relayHome}/`) ? check.logPath.slice(relayHome.length + 1) : check.logPath,
    },
  };
}

export function verificationEvent(handoff: number, workerId: string | null, counts: Verification): PendingEvent {
  return { type: "verification_recorded", data: { handoff, worker_id: workerId, ...counts } };
}

export function providerAllowedEvent(allowed: { account: string; company: string; how: string }): PendingEvent {
  return { type: "provider_allowed", data: { account: allowed.account, company: allowed.company, how: allowed.how } };
}

interface HandoffEventInput {
  number: number;
  fromWorkerId: string | null;
  fromTarget: string | null;
  toTarget: string;
  toWorkerId: string | null;
  checkpointNumber: number;
  checkpointCommit: string;
  handoffRef: string;
  notesSource: "agent" | "relay";
  notesReason: string | null;
  claimsCount: number;
  mismatches: Mismatch[];
  checks: CheckResult[];
  instructionFilesChanged: string[];
  confirmations: { question: string; how: string }[];
  invisibleRemoved: number;
  promptPath: string;
}

export function handoffEvent(input: HandoffEventInput): PendingEvent {
  return {
    type: "handoff",
    data: {
      number: input.number, from_worker_id: input.fromWorkerId, from_target: input.fromTarget, to_target: input.toTarget,
      to_worker_id: input.toWorkerId, checkpoint_number: input.checkpointNumber, checkpoint_commit: input.checkpointCommit,
      handoff_ref: input.handoffRef, notes_source: input.notesSource, notes_reason: input.notesReason, tiers: [0, 1],
      claims_count: input.claimsCount, mismatches: input.mismatches.map(({ claim, found }) => ({ claim, found })),
      checks: input.checks.map(({ command, outcome }) => ({ command, outcome })),
      instruction_files_changed: input.instructionFilesChanged, confirmations: input.confirmations,
      invisible_removed: input.invisibleRemoved, prompt_path: input.promptPath,
    },
  };
}

export function handoffFailedEvent(input: {
  number: number | null; toTarget: string; step: string; reason: string; exitCode: number; keptCheckpoint: number | null;
}): PendingEvent {
  return {
    type: "handoff_failed",
    data: {
      number: input.number, to_target: input.toTarget, step: input.step, reason: input.reason,
      exit_code: input.exitCode, kept_checkpoint: input.keptCheckpoint,
    },
  };
}
