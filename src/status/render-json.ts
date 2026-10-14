// relay status --json (design.md decision 20): one object, schema relay.status/v1. Every field is
// present; unknown values are null. No field adds anything up across accounts.
import type { StatusView } from "./model";

export function renderJson(view: StatusView, now: Date): string {
  const { job } = view;
  const current = job.current_worker;
  const wait = view.resumeAtReset;
  return `${JSON.stringify({
    schema: "relay.status/v1",
    daemon: view.daemon,
    saved_state: view.savedState,
    generated_at: now.toISOString(),
    job: {
      id: job.id,
      title: job.title,
      state: job.state,
      project_root: job.project_root,
      current_worker:
        current === null
          ? null
          : { id: current.id, target: current.target, state: current.state, from_handoff: current.from_handoff, started_at: current.started_at },
    },
    checkpoint: job.last_checkpoint,
    accounts: view.rows.map(({ account, role, activity }) => ({
      target: account.target,
      provider: account.provider,
      provider_name: account.provider_name,
      account: account.account,
      role,
      activity,
      availability: account.availability,
      usage: account.usage,
    })),
    resume_at_reset: wait === null ? null : {
      state: wait.state, target: wait.account, provider_session_id: wait.session_id, reason: wait.stop?.reason ?? null,
      reset_at: wait.stop?.reset_at ?? null, reset_source: wait.stop?.source ?? null, next_check_at: wait.next_check_at,
      resumes: wait.resumes, resumes_in_a_row: wait.resumes_in_a_row, max_resumes: wait.max_resumes,
    },
    t3_resume_at_reset: view.t3Waits.map((entry) => ({
      thread_id: entry.threadId, target: entry.account, state: entry.state, reset_at: entry.reset_at, next_check_at: entry.next_check_at,
    })),
  })}\n`;
}
