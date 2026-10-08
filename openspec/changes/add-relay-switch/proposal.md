# Proposal: `relay switch`, the handoff (phase 4)

## Why

relay exists so that work keeps going when an agent stops: the person types `relay switch codex:personal` and Codex continues the job that Claude Code started, without the person rebuilding the context by hand. Phases 1 to 3 give relay a command line, git checkpoints and adapters that start and stop agents; this change joins them into the handoff itself. It is phase 4 of `docs/ROADMAP.md`, and the demo in `VISION.md` ("start in Claude, hit the limit, open Codex and the work is already continuing") depends on it.

## What Changes

- **`relay switch <provider[:account]>`** hands the job to another agent or account in a fixed order: check that the switch is allowed and possible before touching anything; stop the current agent cleanly through its adapter; save a checkpoint of the work; ask the outgoing agent for handoff notes only when it can still answer, with a time limit, and otherwise build the notes from the event log and the repository; re-run the job's checks; write `.relay/checkpoint.md`; record the handoff in git; start the next agent through its adapter. The output is short and plain: `Stopping Claude Code · personal`, `Saved checkpoint 912ec1`, `Starting Codex · personal`, `Continuing on Codex.` Source: `VISION.md` ("A handoff, step by step"); `docs/research/architecture.md` section 5.
- **Failure handling at every step.** Each step has a defined result when it fails, a rollback that puts relay's files back as they were, an exit code and a message that says what is safe and what to run next. A switch interrupted by a crash is cleaned up by the next `relay switch` or `relay run`. Source: `docs/research/security.md` section 4 ("Rollback guarantees").
- **The handoff builder.** It assembles context tiers 0 and 1 only (repository, diff, task, acceptance criteria, plan, decisions, checkpoint summary, check results, recent events) and never a raw transcript. It writes `.relay/checkpoint.md` from one exact template, in two parts: facts relay checked itself, and text written by agents, which is fenced with a random marker and stripped of invisible characters. Source: `docs/research/architecture.md` section 5 ("What goes into the continuation prompt"); `docs/research/security.md` section 5 ("Prompt injection").
- **Checks run by relay.** The person records the job's check commands (for example `bun test`) with `--check`. At every handoff relay runs them itself, so the next agent gets test results as facts, and relay compares them with the outgoing agent's claims. Differences go at the top of the prompt. Source: `docs/research/architecture.md` section 5 ("Making the next agent check the previous agent's claims", layers 1 and 2).
- **The continuation prompt.** One exact template written only by relay: read `AGENTS.md` or `CLAUDE.md` (each that exists, because Claude Code reads `AGENTS.md` only when there is no `CLAUDE.md`), `.relay/task.md` and `.relay/checkpoint.md`; inspect the diff; verify the claims and write `.relay/verify.md`; continue from the current step. Source: `docs/research/provider-control-surfaces.md` sections 1.2 and 2.5; `docs/research/architecture.md` section 5.
- **Secret scan before anything is written or sent.** The checkpoint diff (through the phase 2 engine), `checkpoint.md`, `state.json`, the new events, the agent's notes, the instructions and the prompt are scanned with gitleaks (phase 2's `scanTexts`). A finding stops the handoff. Source: `docs/research/security.md` section 3.
- **Provider allow list and first-handoff confirmation.** A job moves only to accounts on the project's allow list. The first handoff to a new account asks in plain words, naming the company that will receive the code, and the answer is remembered. Source: `docs/research/security.md` section 6.
- **Permissions never go up.** The next agent runs in the same mode (interactive or headless) and at the same or a lower permission level as the job. relay adds no bypass flag and answers no permission prompt. Source: `docs/research/security.md` section 5.
- **What this change adds to `relay run <provider[:account]>`** (built in phase 3, which keeps the basics: options, checks, worker records, events and exit codes): the start prompt for a new job, a full handoff when the job already had another agent, the allow-list question in place of phase 3's refusal, a checkpoint when the agent exits, and accepting a `relay switch` typed in another terminal. Source: `VISION.md` ("The first version"); `docs/research/architecture.md` section 6.
- **End-to-end tests** with the phase 3 fake agents on scratch git repositories. They prove the order of steps, the exact output, the rollback after each failure, and that the person's branch, index, stash and uncommitted work are untouched. Source: `docs/research/architecture.md` section 9, item 4.

## Capabilities

### New Capabilities

- `agent-switch`: the `relay switch` command: the order of steps, stopping the current agent, the work checkpoint, starting the next agent, output text, options, exit codes, failure handling with rollback, recovery after a crash, and switching a job whose agent runs under `relay run` in another terminal.
- `run-continuation`: what `relay run` does inside a job: the start prompt for a new job, a handoff when another agent worked on the job before, reusing a prepared handoff, accepting switch requests, and a checkpoint when the agent exits.
- `handoff-content`: the handoff notes (asking the outgoing agent, or building them from events and the repository), context tiers 0 and 1, the exact `checkpoint.md` and prompt templates, the fence around agent-written text, `.relay/verify.md`, and the handoff record in git.
- `handoff-checks`: the job's check commands, how relay runs them at a handoff, how results are reported as facts, and how they are compared with the outgoing agent's claims.
- `provider-allow-list`: which accounts may receive a job, the first-handoff question, the warning when work code moves to a personal account, and how answers are remembered.
- `handoff-safety`: the secret scan of everything a handoff writes or sends, the pause when files that instruct agents changed, invisible characters, and the rule that a handoff never raises permissions.

### Modified Capabilities

None. No specs exist yet in `openspec/specs/`. This change builds on capabilities proposed in `add-cli-scaffold`, `add-checkpoint-engine` and `add-provider-adapters`; the points where it extends them are listed under Impact.

## Decisions pending Josué's decision

Approving this proposal approves each recommendation below. All are listed in `docs/ROADMAP.md` under "Decisions waiting for Josué".

1. **Default provider allow list. Pending Josué's decision.** Recommendation: a project allows only the account it started on; the first handoff to every other account, including a second account of the same provider, asks for confirmation, and the answer is remembered in the project's `[[projects]]` entry in `config.toml`. Sources: `docs/research/security.md` section 6, recommendations 1 to 3; `docs/ROADMAP.md`.
2. **Automatic switching between two accounts of the same provider. Pending Josué's decision.** Recommendation: manual only. This change has no automatic switching of any kind; `relay switch claude:work` from `claude:personal` is allowed because the person typed it, and relay shows the provider's policy note before the first such switch. Sources: `docs/research/security.md` section 7; `docs/research/provider-control-surfaces.md` section 9, decision 1.
3. **First release automation. Pending Josué's decision.** Recommendation: manual switching only. Automatic failover is phase 7. Source: `docs/research/architecture.md` section 6 ("How simple the first scheduler should be").
4. **Unattended mode. Pending Josué's decision.** Recommendation: off. The commands in this change start the next agent in the person's terminal. The switch function also supports a headless start for the phase 5 daemon, but it refuses to turn a job that ran in the terminal into a headless one, because that removes the person from the loop. Sources: `docs/research/security.md` section 5; `docs/ROADMAP.md`.
5. **Is `.relay/` committed? Pending Josué's decision.** This change keeps the phase 2 recommendation (no): handoff files live in `.relay/`, which git ignores locally, and in relay's own refs.
6. **Runtime.** This change assumes TypeScript on Bun (phase 1, also pending). Source: `docs/research/architecture.md` section 1.

Smaller choices approved with this proposal (details in design.md): check commands are stored outside the project and changed only from a terminal (decision 9); the handoff is recorded as a commit under `refs/relay/jobs/<job>/handoffs/<n>` (decision 13); the outgoing agent gets 120 seconds to write its notes (decision 6); until the daemon exists, `relay switch` reaches a `relay run` in another terminal with a signal and a request file (decision 15).

## Out of scope

- Automatic failover, reacting to limit signals, and scheduling (phase 7 and later).
- The daemon, the local API and `relay status` (phase 5). `relay switch` works without the daemon.
- Context tiers 2 and 3 (selected transcript excerpts and the raw transcript), and reading any provider transcript file.
- Resuming the same provider session natively when the job returns to an account it used before. Every handoff starts a new session with the continuation prompt.
- Creating worktrees for jobs, unattended runs, and the "full access" permission level.
- A file inside the repository that narrows the allow list, and policies per account type beyond the warning in `provider-allow-list`.
- Pushing checkpoint or handoff refs, `relay gc`, and the lineage view.
- Adapters other than Claude Code and Codex.

## Security

A handoff stops one company's agent, writes commits into the person's repository, and sends code to another company, so this change follows `docs/research/security.md` sections 3 to 7.

- **Git.** Every git command goes through the phase 2 runner (hooks and file-system monitor disabled). The trust check on git configuration and hooks runs before the current agent is stopped. The only refs relay writes are under `refs/relay/`. The person's branch, index, stash and files are never changed. Source: security.md section 4.
- **Secrets.** Everything the handoff writes into `.relay/`, commits or sends to the next agent is scanned first. A finding stops the handoff, names the file or part and line, and never prints the secret. Check output is kept in a private log under `RELAY_HOME`; only a short excerpt reaches `checkpoint.md`, after the scan. Source: security.md section 3.
- **Another company.** A job moves only to accounts on the allow list, the first handoff to a new account needs the person's yes, and a move from a work account to a personal one shows a warning and asks every time. Source: security.md section 6.
- **Prompt injection.** The prompt and the instructions contain only text written by relay, the person's own check commands and numbers. Text written by agents (notes, claims, commit messages, command lines, test output) stays in `checkpoint.md`, inside a fence with a random marker, after invisible characters are removed. If an agent changed `AGENTS.md`, `CLAUDE.md` or other files that instruct agents, relay shows them and asks before the next agent starts. Source: security.md section 5 ("Prompt injection"), recommendations 1 to 3.
- **Permissions.** The next agent never gets a higher permission level or less supervision than the job had. The request for notes runs read-only. relay adds no bypass flag and answers no permission prompt. Source: security.md section 5.
- **Commands relay runs.** Checks run as the person, outside any sandbox, with provider credential variables removed, standard input closed and a time limit. They can only be set from a terminal, because an agent's shell tool has none. A program running as the same user can still edit relay's files; the documentation states this limit. Source: security.md sections 1 and 2.
- **Processes.** relay stops only the agent process it started and still holds. A `relay switch` in another terminal reaches `relay run` with a signal, which the kernel allows only between processes of the same user, after checking the process ID and its start time. Source: earlier research on agent session formats ("relay must interrupt only processes it owns").
- **Visible arguments.** An interactive agent receives the prompt as a command-line argument, which other users of the machine can see with `ps`. The prompt holds no agent-written text and has passed the secret scan.

## Impact

- New code: `src/handoff/` (the switch steps, notes, checks, claims, templates, git record, journal, allow list, safety checks), `src/run/control.ts` (switch requests to a running `relay run`), `src/cli/commands/switch.ts`, and additions to `src/cli/commands/run.ts` and to phase 3's `src/secrets/redact.ts` (`redactEnvValues`). Tests under `test/handoff/` and `test/e2e/`.
- New command: `relay switch` with `--yes`, `--no-summary`, `--no-start`, `--json`, `--check` and `--permission`, already listed by `add-cli-scaffold`. `relay run` gains `--check`, `--yes` and `--no-summary`. New exit codes 31, 32 and 33, which no other change uses.
- Extends `add-cli-scaffold`: a `[handoff]` table in `config.toml` with five settings.
- Uses `add-checkpoint-engine`, which specifies everything this change needs from it: checkpoint kinds `handoff` and `auto`; `.relay/verify.md` as a sixth job file stored in checkpoints when it exists; `scanTexts` beside the checkpoint scan; `saveCheckpoint` with `lockHeld`, so it runs while the switch holds the job lock; `appendEvent`; and `removeInvisible` in `src/text/invisible.ts`, the one list of invisible characters.
- Uses `add-provider-adapters`, which specifies the adapter `stop` operation, interactive Claude Code sessions started with `--session-id` (so they can be asked for notes later), the instructions text, the worker events and `relay run`. This change replaces `relay run`'s refusal of an account that is not on the allow list with the first-handoff question.
- Matches `add-daemon-api-and-status`: the switch function takes a start mode, refuses a headless start for a job that runs in the terminal, and writes the `worker_started`, `worker_ended` and `handoff` events that the daemon indexes, with the field names of `add-provider-adapters` decision 16.
- Matches `add-handoff-evaluation`: `relay switch --yes --json`, the `handoff` event's `claims_count` and `mismatches`, and the `.relay/verify.md` table format.
- New files under `RELAY_HOME/jobs/<job>/`: `handoff-settings.json`, `handoffs/<n>/`, `switch.json`, `requests/`; and `logs/checks/`. New fields in phase 3's worker lock file `RELAY_HOME/locks/<job>.worker.lock`, which also serves as the record of the `relay run` that `relay switch` reaches.
- New documentation: `docs/handoff.md`.
- No new dependency. Uses gitleaks as phase 2 requires.
