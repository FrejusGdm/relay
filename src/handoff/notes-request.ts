// Asks the outgoing agent for handoff notes (add-relay-switch, design decision 6). relay asks only
// when the agent can answer, by resuming its session headless at read-only on its own account,
// waits at most handoff.summary_timeout_seconds, and never answers a permission request.
import { buildAgentEnv } from "../accounts/environment";
import type { AvailabilityState, Capabilities, FailureReason, ProviderAdapter, WorkerHandle } from "../adapters/types";
import type { Account } from "../core/config/types";
import { printable } from "../core/quote";
import { displayName } from "./account";

export const NOTES_REQUEST = `relay is moving this job to another coding agent. Do not change any file and do not run commands that change anything. Write handoff notes for the next agent, in English, under 400 words, using only what you know from this session. Use exactly these sections and nothing else:

## Done
- One line per finished piece of work.

## In progress
- What you were doing when you stopped: the part that is finished and the part that is left.

## Next steps
1. The next concrete steps, in order.

## Decisions
- Decision. Reason. Include choices you made without stating them (for example a library, a file layout or a naming style) and anything the user asked for in this session that is not written down in the project's files.

## Files touched
- One path per line, relative to the project folder.

## Claims to verify
- One checkable statement per line. Check: the command to run and its expected result, or the file and what it should contain.

## Problems
- Anything that is broken, blocked or uncertain, and anything you learned that the code does not show (for example a test that needs a running service). Give the evidence, such as an error message.`;

export interface OutgoingWorker {
  workerId: string;
  // The account the worker ran on, or null when it was removed from config.toml since.
  account: Account | null;
  accountId: string;
  provider: Account["provider"];
  sessionId: string | null;
  // The capabilities of the transport the worker ran in.
  capabilities: Capabilities;
  // The reason of the worker's last turn_failed event, if any.
  lastFailure: FailureReason | null;
  availability: AvailabilityState;
}

const LIMIT_WORDS: Partial<Record<FailureReason | AvailabilityState, string>> = {
  usage_limit: "was at its usage limit",
  quota_exhausted: "was at its usage limit",
  rate_limit: "was at its rate limit",
  rate_limited: "was at its rate limit",
  auth: "could not sign in",
  billing: "has a billing problem",
  unavailable: "is unavailable",
};

// The first reason relay cannot ask, in the order of design decision 6, or null when it can ask.
// `askForNotes` is false with --no-summary ("flag") or handoff.ask_for_summary = false ("config").
export function notesSkipReason(askForNotes: true | "flag" | "config", worker: OutgoingWorker): string | null {
  const name = displayName(worker.provider);
  if (askForNotes === "flag") return "you passed --no-summary";
  if (askForNotes === "config") return "notes are turned off in config.toml";
  if (worker.sessionId === null) return `${name} did not report a session ID, so it cannot be asked after it stops`;
  if (!worker.capabilities.nativeResume) return `${name} cannot resume a session`;
  const limit = (worker.lastFailure === null ? undefined : LIMIT_WORDS[worker.lastFailure]) ?? LIMIT_WORDS[worker.availability];
  if (limit !== undefined) return `${name} ${limit}`;
  if (worker.account === null) return `the account ${worker.accountId} was removed`;
  return null;
}

interface NotesRequest {
  adapter: ProviderAdapter;
  account: Account;
  sessionId: string;
  jobId: string;
  // A new worker ID for the resumed session.
  workerId: string;
  cwd: string;
  instructions: string;
  env: Record<string, string | undefined>;
  logPath: string;
  timeoutMs: number;
  stopTimeoutMs: number;
}

type NotesAnswer =
  | { outcome: "received"; text: string; seconds: number }
  | { outcome: "timed_out" | "failed"; reason: string; seconds: number };

export async function requestNotes(request: NotesRequest): Promise<NotesAnswer> {
  const name = displayName(request.account.provider);
  const started = performance.now();
  const seconds = () => Math.round((performance.now() - started) / 1000);
  const failed = (why: string): NotesAnswer => ({ outcome: "failed", reason: `the request failed: ${why}`, seconds: seconds() });
  let worker: WorkerHandle;
  try {
    worker = await request.adapter.start(request.account, {
      jobId: request.jobId,
      workerId: request.workerId,
      cwd: request.cwd,
      mode: "headless",
      permission: "read-only",
      resumeSessionId: request.sessionId,
      instructions: request.instructions,
      prompt: NOTES_REQUEST,
      env: buildAgentEnv(request.account, request.env, { jobId: request.jobId, workerId: request.workerId }),
      logPath: request.logPath,
    });
  } catch (error) {
    return failed(printable((error as Error).message));
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timed_out">((done) => { timer = setTimeout(() => done("timed_out"), request.timeoutMs); });
  const read = (async (): Promise<NotesAnswer> => {
    let text = "";
    try {
      for await (const event of worker.events()) {
        if (event.kind === "message" && !event.partial) text = event.text;
        else if (event.kind === "approval_needed" || event.kind === "permission_denied") return failed("the agent asked for permission");
        else if (event.kind === "turn_failed") return failed(event.reason);
        else if (event.kind === "turn_completed") {
          return text.trim() === "" ? failed(`${name} gave an empty answer`) : { outcome: "received", text, seconds: seconds() };
        } else if (event.kind === "exited") break;
      }
    } catch (error) {
      return failed(printable((error as Error).message));
    }
    return failed(`${name} exited before it answered`);
  })();
  const answer = await Promise.race([read, timedOut]);
  clearTimeout(timer);
  await worker.stop({ timeoutMs: request.stopTimeoutMs });
  if (answer === "timed_out") {
    const limit = Math.round(request.timeoutMs / 1000);
    return { outcome: "timed_out", reason: `${name} did not answer within ${limit} ${limit === 1 ? "second" : "seconds"}`, seconds: seconds() };
  }
  return answer;
}
