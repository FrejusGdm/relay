# Tasks

Every task is one small commit on the branch `feat/resume-at-reset`. Josué asked on 2026-10-13
for this change to be built and tested on his Mac, so the commands below run there. Tests never
call a real provider or a real T3 Code: they use `fake-claude`, `fake-codex` and the fake T3
server. "design.md N" means decision N in this change's design.md.

## 1. Fakes and the failure reason

- [x] 1.1 Add `runs`, a `limit` step without `resets_at`, and the `"credits"` limit kind to the
  scenario files (`test/fakes/scenario.ts`, `fake-claude.ts`, `fake-codex.ts`,
  `docs/testing-adapters.md`). Verify with `bun test test/fakes`.
- [x] 1.2 Add the failure reason `credits_required` to the Claude Code stream mapper and to
  `relay run`'s closing lines (design.md 8). Verify with `bun test test/adapters test/run/headless.test.ts`.

## 2. The wait and the scheduler

- [x] 2.1 Add `src/resume/wait.ts` (the wait file under its lock) and `src/resume/timing.ts` (reset
  time sources, the 60-second margin, the 15-minute checks, the 7-day end), design.md 1 to 4.
  Verify with `bun test test/resume/timing.test.ts test/resume/wait.test.ts`.
- [x] 2.2 Add `src/resume/jobs.ts`, the daemon's scheduler for job waits, and `lastEnd` on
  `JobSupervisor` (design.md 5). Start it in `src/daemon/main.ts`. Verify with
  `bun test test/resume/jobs.test.ts`, which covers a known reset time, an unknown reset time, the
  limit hit again three times, `credits_required`, another failure, a job that moved on, two jobs on
  one account, and cancelling.

## 3. relay run, relay status and the off command

- [x] 3.1 Add `--resume-at-reset` and `--max-resumes` to `relay run`, and the follower that prints
  the job's progress until the wait ends (design.md 6). Verify with
  `bun test test/resume/run.test.ts`, which runs the real program with the fakes and a real daemon:
  a limit with a reset a few seconds away that is resumed and finishes, Ctrl+C cancelling the wait,
  and the daemon restarting during the wait.
- [x] 3.2 Add the wait to `relay status` (text and `--json`) and the command
  `relay resume-at-reset off [--job <id>] [--thread <id>]`. Verify with
  `bun test test/resume/status.test.ts test/cli`.

## 4. T3 Code threads

- [x] 4.1 Add `[t3.resume_at_reset]` to the settings (`src/core/config/`, `docs/config.md`,
  `docs/config.example.toml`). Verify with `bun test test/core`.
- [x] 4.2 Add `src/t3/resume.ts`, the 60-second watcher with its state file and event log
  (design.md 10 and 11), and start it in the daemon. Extend the fake T3 server. Verify with
  `bun test test/t3/resume.test.ts`, which covers a Claude limit with a reset time, a Codex limit,
  another failure, a thread busy at the reset, a thread T3 already continued, a daemon restart after
  sending, the limit hit again, and cancelling.
- [x] 4.3 Add `relay t3 connect` and `relay t3 disconnect` and the exit codes 40 to 42
  (design.md 12). Verify with `bun test test/t3 test/cli`.

## 5. Documents and the whole check

- [x] 5.1 Update `docs/cli.md`, `docs/daemon.md`, `docs/adapters.md`, `README.md` and
  `docs/progress.md`. Verify with `bun test test/docs test/cli`.
- [x] 5.2 Run `bun run typecheck`, `bun run test` and
  `openspec validate add-resume-at-reset --strict --no-interactive`; all must pass.
- [x] 5.3 Manual check, written up in the pull request: in a scratch repository, start
  `relay run claude:work --headless --resume-at-reset --prompt …` against `fake-claude` with a
  scenario whose first run stops at a limit that resets one minute later, and show that relay
  waits, resumes and finishes with exit code 0.
