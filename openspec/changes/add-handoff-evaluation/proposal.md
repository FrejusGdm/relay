# Proposal

## Why

Phase 7 of `docs/ROADMAP.md` (single-job failover) will hand a job to another agent with nobody
watching, so it is only worth building if a handoff made by `relay switch` actually preserves the
work. Today we have no evidence either way: research says model-written summaries can be wrong and
recommends measuring handoff quality on real tasks before adding automation
(`docs/research/architecture.md`, section 5, "Measuring handoff quality", and "First build steps,
in order", step 6). This change defines that measurement so the founder can run it on his own
subscriptions once phases 1 to 5 exist, and decide on failover from numbers instead of hope.

## What Changes

- Add four fixture tasks under `eval/handoff/tasks/`: small, real coding tasks in self-contained
  repositories (three in TypeScript on Bun, one in Python with only the standard library), each
  with a task description and acceptance criteria the agent sees, hidden acceptance tests the agent
  never sees, and a reference solution that proves the tests can be passed. Research recommends
  hidden acceptance tests (`architecture.md`, section 5); the number of tasks is smaller than the
  10 to 20 the research suggests, to keep the cost on the founder's subscriptions reasonable, and
  matches the "two or three real tasks" of `architecture.md`, "First build steps", step 6.
- Add a harness, `eval/handoff/`, run with `bun run eval:handoff <command>`. It runs each task once
  with a single agent and no interruption (the baseline), and again with an interruption at 25, 50
  or 75 percent of the baseline's steps, or at a defined event, followed by `relay switch` to
  another agent or account. It never adds anything to the `relay` binary.
- Measure, for every run: hidden acceptance tests passed, wall-clock time, tokens and subscription
  usage where the provider reports them, claims in the handoff that turned out to be false, files
  and lines the next agent had to rework, regressions after the handoff, and relay's own safety
  guarantees (the scratch repository's branch, index and uncommitted file are unchanged). These
  are the metrics of `architecture.md`, section 5, with "claims the next agent had to correct"
  taken from the verification file of section 5, "Making the next agent check the previous
  agent's claims".
- Record one JSON result file per run and build a summary table (`summary.md` and `summary.csv`)
  per campaign, with a verdict per handoff direction.
- Guard the cost: the harness refuses to run in CI, needs a terminal, shows the expected agent
  time and the companies that will receive the fixture code, and waits for the founder to type
  `yes`. Its own unit tests and an end-to-end test with relay's fake agents never call a provider
  (`architecture.md`, section 9, item 6: real providers appear only in this opt-in evaluation).
- Document how to run it in `eval/handoff/README.md`.

### Recommendations pending Josué's decision

Approving this proposal approves these recommendations.

1. **What result justifies building automatic failover (pending Josué's decision).** Evaluated
   separately for each direction (for example Claude to Codex) on the standard plan, all six of
   these must hold:
   - safety: no run broke relay's repository guarantees;
   - reliability: `relay switch` succeeded in at least 17 of 18 handoffs;
   - quality: the share of handoff runs that pass every acceptance test is at most 10 percentage
     points below the share for the weaker of the two agents working alone on the same tasks,
     and at most 2 of 18 handoff runs lost an acceptance test that passed at the handoff;
   - reuse: after handoffs at 50 and 75 percent, the next agent's median time is at most 75
     percent of its time on the same task from scratch;
   - rework: the median share of the first agent's added lines that the next agent removed or
     rewrote is at most 15 percentage points above the same share in the uninterrupted runs;
   - verification: the next agent wrote its verification file in at least 16 of 18 handoffs.
   If all hold, build failover for that direction. If safety or reliability fails, fix relay
   first. If only the others fail, improve the handoff (context tiers, claim checks) and run the
   evaluation again. Automatic switching between two accounts of the same provider stays off
   whatever the result, because that is a terms question, not a quality question
   (`docs/research/security.md`, section 7; ROADMAP decision "Automatic switching between two
   accounts of the same provider").
2. **Size of the standard plan (pending Josué's decision):** 60 runs, about 25 hours of agent
   time split between `claude:personal` and `codex:personal`, run over several days as the
   subscription windows allow. A two-run smoke plan (about 35 minutes) checks the harness first.
3. **The evaluation is a supervised experiment, not relay's unattended mode (pending Josué's
   decision).** The founder starts it in a terminal; agents work only in scratch copies of the
   synthetic fixtures, with the provider's sandbox on and no permission-bypass flags. It may keep
   running while he is away. The ROADMAP decision "Unattended mode: Off" stays unchanged for real
   projects (`security.md`, section 5, "What relay should require before continuing work while
   the person is away").
4. **Where results live (pending Josué's decision):** per-run files stay outside the repository in
   `~/.relay-eval/`; the final `summary.md` of a campaign is copied into
   `docs/evaluations/handoff-<date>.md` and committed, because it is the evidence for the
   failover decision.

## Out of scope

- Automatic failover itself (phase 7), and any change to the `relay` binary. If an interface the
  harness needs is missing from the approved phase 1 to 5 specs, it is added to that phase's
  change (see design.md, "Interfaces the harness needs from relay").
- Comparing context tiers (0 alone, or 0, 1 and 2). Phase 4 builds tiers 0 and 1 only, so the
  evaluation uses relay's default handoff. A later campaign can add tiers when `relay switch` can
  choose them (`architecture.md`, section 5).
- Planting deliberately false claims in checkpoints to measure how many the next agent catches
  (`architecture.md`, section 5). It needs a way to edit a handoff between its creation and the
  next agent's start, which relay does not have; this change measures the false claims that occur
  naturally instead.
- Running in CI, scheduling runs, or any telemetry. Results stay on the founder's machine.
- Cursor, T3 Code and OpenCode targets.

## Security

- **Another provider.** The evaluation sends the fixture repositories to Anthropic and OpenAI. The
  fixtures are synthetic code written for this evaluation and contain no secrets or private code.
  Before a campaign starts, the harness names each company and account that will receive them and
  waits for `yes` (`security.md`, section 6). It answers relay's own first-handoff question only
  after that confirmation, and never answers an agent's permission prompt.
- **Credentials.** The harness never reads, copies or logs credential files, Keychain entries or
  credential environment variables. It uses the accounts the founder set up in relay, and relay
  removes credential variables when it starts an agent (`security.md`, section 2).
- **Git.** The harness only touches scratch repositories it created under `~/.relay-eval/work/`.
  Every git command it runs disables hooks and `core.fsmonitor`. Its own per-step snapshots go to
  `refs/relay-eval/...` in the scratch repository, never to a branch (`security.md`, section 4).
- **Permissions.** Fixtures ship Claude Code settings with the sandbox on and the `dontAsk`
  permission mode with an allow list; relay's Codex adapter runs with the sandbox
  `workspace-write`. The harness refuses a run whose recorded command line contains a bypass flag
  (`security.md`, section 5).
- **Results.** Result files hold counts, hashes, timings, account labels and copies of relay's own
  handoff files, which relay already scanned for secrets. They never hold provider transcripts or
  session files (earlier research on agent session formats, "How relay can use these formats
  safely").

## Capabilities

### New Capabilities

- `handoff-evaluation`: the opt-in, manually run evaluation of handoff quality: fixture tasks with
  hidden acceptance tests, plans and campaigns, baseline and interrupted runs through
  `relay switch`, the measurements, per-run result files, the summary table and the failover
  verdict.

### Modified Capabilities

None.

## Impact

- New directory `eval/handoff/` (harness source, tests, plans, fixtures, README) and a
  `docs/evaluations/` folder for committed summaries. A new script `eval:handoff` in the root
  `package.json` from phase 1.
- No new dependencies: Bun's built-in TOML parser, `HTMLRewriter` (used to read JUnit XML), test
  runner and `Bun.spawn`, plus `git` and `python3`.
- Depends on phases 1 to 5, and only on interfaces their changes already specify (design.md,
  decision 2): `relay init`, `relay checkpoint --json`, `relay run --headless --json`,
  `relay switch <target> --yes --json` (phase 4), `relay status --json` (phase 5), and the event
  log. Steps are phase 3's `command_ran` and `file_changed` events, usage is the `usage` field of
  phase 3's `turn_completed` event, and a worker is stopped by interrupting the `relay run`
  process the harness started (phase 3), so no `relay stop` command is needed.
- Costs real subscription usage when the founder runs it; the cost is shown before each campaign.
